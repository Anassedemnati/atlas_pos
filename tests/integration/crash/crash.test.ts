import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../../../src/main/infrastructure/db/connection'

/**
 * Power-cut harness. A child process (writer.mjs) sells without pause through the real order use
 * cases: lines one by one, a cash payment, a ticket every 5 lines. The test SIGKILLs it at a random
 * moment, reopens the same database (this is where SQLite recovers the WAL) and checks that nothing a
 * writer reported as committed was lost, and that nothing half-written is visible. The same file is
 * reused across all iterations, like a till that loses power again and again. About one kill in three
 * is not followed by the test's own reopen: the next writer is then the one that recovers the WAL the
 * killed one left, as the till does after a power cut.
 *
 * What a SIGKILL proves: no transaction is ever half-applied and WAL recovery works. It cannot
 * prove that `synchronous=FULL` really reaches the disk, because the operating system keeps
 * running and still flushes its cache. That half rests on the pragma itself (connection.test.ts).
 *
 * Env: CRASH_ITER (iterations, default 50), CRASH_SEED (reproduces the kill times).
 */

const WRITER = fileURLToPath(new URL('./writer.mjs', import.meta.url))
/** An integer environment variable in [min, max]; anything else stops the run with a clear message. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`)
  }
  return value
}

const ITERATIONS = envInt('CRASH_ITER', 50, 1, 10_000)
const SEED = envInt('CRASH_SEED', Math.floor(Math.random() * 2 ** 32), 0, 2 ** 32 - 1)
/** Share of kills after which the test does not reopen the database itself. */
const SKIP_REOPEN = 0.3
const KILL_AFTER_MS = { min: 50, max: 400 }
const LINES_PER_TICKET = 5
const WRITER_START_TIMEOUT_MS = 30_000

/** Small seeded PRNG (mulberry32), so a failing run can be replayed with CRASH_SEED. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

interface Acks {
  /** Ids of the order lines the writer reported as committed. */
  lines: string[]
  /** Ids of the payments the writer reported as committed. */
  payments: string[]
  /** Numbers of the tickets the writer reported as committed. */
  tickets: number[]
}

const noAcks = (): Acks => ({ lines: [], payments: [], tickets: [] })
const addAcks = (to: Acks, from: Acks): void => {
  to.lines.push(...from.lines)
  to.payments.push(...from.payments)
  to.tickets.push(...from.tickets)
}

interface WriterRun {
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
  code: number | null
}

const READY_POLL_MS = 5

/**
 * Starts the writer, waits for its READY line (so that Node start-up and the migrations do not eat
 * the kill window), then SIGKILLs it after `killAfterMs`. Resolves once the process is gone.
 *
 * The writer's stdout is a FILE, not a pipe, on purpose. With a pipe the parent wakes up on every
 * ACK, so its kill timer fires right after the child's write, i.e. right after a commit, and the
 * kill never lands between two statements of a use case (a writer that commits a ticket and
 * closes its order in two transactions went undetected). With a file the parent is only woken by
 * its own timer and the kill hits the child at an arbitrary point of its cycle. A completed
 * write() to a file survives SIGKILL, so no ACK can be lost.
 */
function runWriterUntilKilled(dbFile: string, outFile: string, killAfterMs: number): Promise<WriterRun> {
  return new Promise((resolve, reject) => {
    const out = openSync(outFile, 'w')
    // The types are stripped by Node itself (writer.mjs + ts-hooks.mjs), no build step.
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', WRITER, dbFile],
      { stdio: ['ignore', out, 'pipe'] }
    )
    closeSync(out)
    let stderr = ''
    let killTimer: NodeJS.Timeout | undefined
    const startedAt = Date.now()
    const readyPoll = setInterval(() => {
      if (readFileSync(outFile, 'utf8').includes('READY\n')) {
        clearInterval(readyPoll)
        killTimer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
      } else if (Date.now() - startedAt > WRITER_START_TIMEOUT_MS) {
        clearInterval(readyPoll)
        child.kill('SIGKILL')
        reject(new Error(`writer printed no READY within ${WRITER_START_TIMEOUT_MS} ms\n${stderr}`))
      }
    }, READY_POLL_MS)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => {
      clearInterval(readyPoll)
      clearTimeout(killTimer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearInterval(readyPoll)
      clearTimeout(killTimer)
      resolve({ stdout: readFileSync(outFile, 'utf8'), stderr, signal, code })
    })
  })
}

/** ACKs from the writer's stdout. The last line may have been cut by the kill: only complete lines count. */
function parseAcks(stdout: string): Acks {
  const acks = noAcks()
  const complete = stdout.split('\n').slice(0, -1)
  for (const line of complete) {
    if (line === 'READY') continue
    const match = /^ACK (line|payment|ticket) (\S+)$/.exec(line)
    if (!match) throw new Error(`unexpected writer output: ${JSON.stringify(line)}`)
    if (match[1] === 'line') acks.lines.push(match[2]!)
    else if (match[1] === 'payment') acks.payments.push(match[2]!)
    else acks.tickets.push(Number(match[2]))
  }
  return acks
}

const all = <T>(db: Database, sql: string): T[] => db.prepare(sql).all() as T[]
const scalar = (db: Database, sql: string): unknown => db.prepare(sql).pluck().get()

/**
 * Everything that must hold on the database after any number of power cuts. `where` labels the
 * failure. Returns the number of tickets, to check that the till only ever moves forward.
 */
function assertConsistent(db: Database, acks: Acks, where: string): number {
  const say = (what: string): string => `${where}: ${what}`

  expect(scalar(db, 'PRAGMA quick_check'), say('quick_check')).toBe('ok')
  expect(all(db, 'PRAGMA foreign_key_check'), say('foreign_key_check')).toEqual([])

  // Every ACKed line and ticket is there.
  const lineIds = new Set(all<{ id: string }>(db, 'SELECT id FROM order_lines').map((r) => r.id))
  const lost = acks.lines.filter((id) => !lineIds.has(id))
  expect(lost, say(`ACKed order lines missing: ${lost.length} of ${acks.lines.length}`)).toEqual([])
  const paymentIds = new Set(all<{ id: string }>(db, 'SELECT id FROM payments').map((r) => r.id))
  const lostPayments = acks.payments.filter((id) => !paymentIds.has(id))
  expect(lostPayments, say(`ACKed payments missing: ${lostPayments.length} of ${acks.payments.length}`)).toEqual([])

  // Ticket numbers are exactly 1..N: no gap, no duplicate. The counter agrees.
  const numbers = all<{ number: number }>(db, "SELECT number FROM tickets WHERE kind = 'sale' ORDER BY number").map(
    (r) => r.number
  )
  expect(numbers, say('ticket numbers are 1..N')).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1))
  const counter = scalar(db, "SELECT value FROM sequences WHERE name = 'ticket'") ?? 0
  expect(counter, say('ticket counter equals the number of tickets')).toBe(numbers.length)
  const have = new Set(numbers)
  const missing = acks.tickets.filter((n) => !have.has(n))
  expect(missing, say(`ACKed tickets missing: ${missing.join(', ')}`)).toEqual([])
  expect(scalar(db, "SELECT count(*) FROM tickets WHERE kind != 'sale'"), say('the writer never cancels')).toBe(0)
  expect(
    all(
      db,
      `SELECT number FROM tickets
        WHERE label != printf('%06d', number)
           OR json_extract(snapshot_json, '$.label') != label
           OR json_extract(snapshot_json, '$.number') != number
           OR json_extract(snapshot_json, '$.kind') != kind
           OR json_extract(snapshot_json, '$.totals.totalCents') != total_cents`
    ),
    say('ticket label is the 6-digit number, and the snapshot agrees with its row')
  ).toEqual([])

  // A ticket and its order's closing are one atomic fact, in both directions.
  expect(
    all(
      db,
      `SELECT t.number FROM tickets t LEFT JOIN orders o ON o.id = t.order_id
        WHERE o.id IS NULL OR o.status != 'closed'`
    ),
    say("a ticket exists whose order is not 'closed'")
  ).toEqual([])
  expect(
    all(db, "SELECT o.id FROM orders o WHERE o.status = 'closed' AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id)"),
    say('an order is closed without a ticket')
  ).toEqual([])
  expect(scalar(db, 'SELECT count(*) - count(DISTINCT order_id) FROM tickets'), say('two tickets for one order')).toBe(0)

  // Payments: a closed order was paid exactly its total, and its ticket lists those payments. The
  // receipt job was written with the ticket (a job exists if and only if its ticket does).
  expect(
    all(
      db,
      `SELECT t.number FROM tickets t
        WHERE t.total_cents != (SELECT COALESCE(sum(p.amount_cents), 0) FROM payments p WHERE p.order_id = t.order_id)
           OR json_extract(t.snapshot_json, '$.paidCents') != t.total_cents
           OR json_array_length(t.snapshot_json, '$.payments')
              != (SELECT count(*) FROM payments p WHERE p.order_id = t.order_id)`
    ),
    say("a ticket's payments do not match its order's")
  ).toEqual([])
  expect(
    all(
      db,
      `SELECT t.number FROM tickets t
        WHERE (SELECT count(*) FROM print_jobs j
                WHERE j.kind = 'receipt' AND json_extract(j.payload_json, '$.ticketId') = t.id) != 1`
    ),
    say('a ticket without exactly one receipt job')
  ).toEqual([])
  expect(
    scalar(
      db,
      `SELECT count(*) FROM print_jobs j WHERE j.kind = 'receipt'
         AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = json_extract(j.payload_json, '$.ticketId'))`
    ),
    say('a receipt job without its ticket')
  ).toBe(0)

  // Lines: contiguous per order. A closed order has exactly the lines its ticket snapshot has.
  expect(
    all(
      db,
      `SELECT order_id FROM order_lines GROUP BY order_id HAVING min(seq) != 1 OR max(seq) != count(*)`
    ),
    say('order line sequence has a gap')
  ).toEqual([])
  expect(
    all(
      db,
      `SELECT t.number FROM tickets t
        WHERE (SELECT count(*) FROM order_lines l WHERE l.order_id = t.order_id) != ${LINES_PER_TICKET}
           OR json_array_length(t.snapshot_json, '$.lines') != ${LINES_PER_TICKET}`
    ),
    say(`a ticket's order does not have its ${LINES_PER_TICKET} lines`)
  ).toEqual([])
  // At most the order that was being rung up when the power went (empty, part-filled, full, or full
  // and paid when the cut came before its close). Only a full order is paid, never above its total.
  const open = all<{ id: string; lines: number; paid: number; total: number }>(
    db,
    `SELECT o.id,
            (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id) AS lines,
            (SELECT COALESCE(sum(p.amount_cents), 0) FROM payments p WHERE p.order_id = o.id) AS paid,
            (SELECT COALESCE(sum(l.unit_price_cents * l.qty_milli / 1000), 0) FROM order_lines l WHERE l.order_id = o.id) AS total
       FROM orders o WHERE o.status != 'closed'`
  )
  expect(open.length, say('more than one unfinished order')).toBeLessThanOrEqual(1)
  for (const o of open) {
    expect(o.lines, say('unfinished order has too many lines')).toBeLessThanOrEqual(LINES_PER_TICKET)
    if (o.paid > 0) expect(o.lines, say('an order was paid before its last line')).toBe(LINES_PER_TICKET)
    expect(o.paid, say('an unfinished order is paid above its total')).toBeLessThanOrEqual(o.total)
  }

  return numbers.length
}

describe('power-cut crash harness (SIGKILL)', () => {
  let dir = ''
  let dbFile = ''
  let passed = false
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-crash-'))
    dbFile = join(dir, 'atlas.db')
  })
  afterAll(() => {
    if (dir === '') return
    // A failed run keeps its database for inspection.
    if (passed) rmSync(dir, { recursive: true, force: true })
    else console.error(`crash harness: database kept in ${dir} (CRASH_SEED=${SEED})`)
  })

  it(
    `keeps every committed line, payment and ticket across ${ITERATIONS} kills`,
    async () => {
      const random = prng(SEED)
      const everything = noAcks()
      // What the writers ACKed since the database was last checked.
      let unchecked = noAcks()
      let previousTickets = 0

      for (let i = 1; i <= ITERATIONS; i++) {
        const killAfterMs = Math.round(KILL_AFTER_MS.min + random() * (KILL_AFTER_MS.max - KILL_AFTER_MS.min))
        const reopen = i === ITERATIONS || random() >= SKIP_REOPEN
        const where = `iteration ${i}/${ITERATIONS} (CRASH_SEED=${SEED}, kill after ${killAfterMs} ms)`

        const run = await runWriterUntilKilled(dbFile, join(dir, `writer-${i}.out`), killAfterMs)
        // Anything but our own SIGKILL means the writer is broken, and the checks below would prove nothing.
        expect(run.signal, `${where}: writer ended by itself (code ${run.code})\n${run.stderr}`).toBe('SIGKILL')
        const acks = parseAcks(run.stdout)
        addAcks(everything, acks)
        addAcks(unchecked, acks)
        if (!reopen) continue

        // Reopening runs WAL recovery on whatever the killed process left behind.
        const db = openDatabase(dbFile)
        try {
          const tickets = assertConsistent(db, unchecked, where)
          expect(tickets, `${where}: tickets only ever increase`).toBeGreaterThanOrEqual(previousTickets)
          previousTickets = tickets
        } finally {
          db.close()
        }
        unchecked = noAcks()
      }

      // Nothing from any earlier iteration disappeared later, and the run was not vacuous.
      const db = openDatabase(dbFile)
      try {
        assertConsistent(db, everything, `after all ${ITERATIONS} iterations`)
      } finally {
        db.close()
      }
      expect(everything.lines.length, 'the writer committed lines').toBeGreaterThan(0)
      if (ITERATIONS >= 10) {
        expect(everything.payments.length, 'the writer committed payments').toBeGreaterThan(0)
        expect(everything.tickets.length, 'the writer committed tickets').toBeGreaterThan(0)
      }
      passed = true
    },
    // About 0.7 s per iteration on a laptop; generous for a slow CI disk (synchronous=FULL fsyncs).
    120_000 + ITERATIONS * 5_000
  )
})
