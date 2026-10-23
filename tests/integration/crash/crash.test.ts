import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../../../src/main/infrastructure/db/connection'

/**
 * Power-cut harness. A child process (writer.mjs) sells without pause, on the real database layer:
 * lines one by one, a ticket every 5 lines. The test SIGKILLs it at a random moment, reopens the
 * same database (this is where SQLite recovers the WAL) and checks that nothing a writer reported
 * as committed was lost, and that nothing half-written is visible. The same file is reused across
 * all iterations, like a till that loses power again and again.
 *
 * What a SIGKILL proves: no transaction is ever half-applied and WAL recovery works. It cannot
 * prove that `synchronous=FULL` really reaches the disk, because the operating system keeps
 * running and still flushes its cache. That half rests on the pragma itself (connection.test.ts).
 *
 * Env: CRASH_ITER (iterations, default 50), CRASH_SEED (reproduces the kill times).
 */

const WRITER = fileURLToPath(new URL('./writer.mjs', import.meta.url))
const ITERATIONS = Number(process.env.CRASH_ITER ?? 50)
const SEED = Number(process.env.CRASH_SEED ?? Math.floor(Math.random() * 2 ** 32))
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
  /** Numbers of the tickets the writer reported as committed. */
  tickets: number[]
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
  const acks: Acks = { lines: [], tickets: [] }
  const complete = stdout.split('\n').slice(0, -1)
  for (const line of complete) {
    if (line === 'READY') continue
    const match = /^ACK (line|ticket) (\S+)$/.exec(line)
    if (!match) throw new Error(`unexpected writer output: ${JSON.stringify(line)}`)
    if (match[1] === 'line') acks.lines.push(match[2]!)
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
  expect(
    scalar(db, "SELECT count(*) FROM tickets WHERE label != printf('%06d', number)"),
    say('ticket label is the 6-digit number')
  ).toBe(0)

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
  // At most the order that was being rung up when the power went (it may already hold 5 lines if
  // the cut came between its last line and its close).
  const open = all<{ id: string; lines: number }>(
    db,
    `SELECT o.id, (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id) AS lines
       FROM orders o WHERE o.status != 'closed'`
  )
  expect(open.length, say('more than one unfinished order')).toBeLessThanOrEqual(1)
  for (const o of open) expect(o.lines, say('unfinished order has too many lines')).toBeLessThanOrEqual(LINES_PER_TICKET)

  return numbers.length
}

describe('power-cut crash harness (SIGKILL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-crash-'))
  const dbFile = join(dir, 'atlas.db')
  let passed = false
  afterAll(() => {
    // A failed run keeps its database for inspection.
    if (passed) rmSync(dir, { recursive: true, force: true })
    else console.error(`crash harness: database kept in ${dir} (CRASH_SEED=${SEED})`)
  })

  it(
    `keeps every committed line and ticket across ${ITERATIONS} kills`,
    async () => {
      const random = prng(SEED)
      const everything: Acks = { lines: [], tickets: [] }
      let previousTickets = 0

      for (let i = 1; i <= ITERATIONS; i++) {
        const killAfterMs = Math.round(KILL_AFTER_MS.min + random() * (KILL_AFTER_MS.max - KILL_AFTER_MS.min))
        const where = `iteration ${i}/${ITERATIONS} (CRASH_SEED=${SEED}, kill after ${killAfterMs} ms)`

        const run = await runWriterUntilKilled(dbFile, join(dir, `writer-${i}.out`), killAfterMs)
        // Anything but our own SIGKILL means the writer is broken, and the checks below would prove nothing.
        expect(run.signal, `${where}: writer ended by itself (code ${run.code})\n${run.stderr}`).toBe('SIGKILL')
        const acks = parseAcks(run.stdout)
        everything.lines.push(...acks.lines)
        everything.tickets.push(...acks.tickets)

        // Reopening runs WAL recovery on whatever the killed process left behind.
        const db = openDatabase(dbFile)
        try {
          const tickets = assertConsistent(db, acks, where)
          expect(tickets, `${where}: tickets only ever increase`).toBeGreaterThanOrEqual(previousTickets)
          previousTickets = tickets
        } finally {
          db.close()
        }
      }

      // Nothing from any earlier iteration disappeared later, and the run was not vacuous.
      const db = openDatabase(dbFile)
      try {
        assertConsistent(db, everything, `after all ${ITERATIONS} iterations`)
      } finally {
        db.close()
      }
      expect(everything.lines.length, 'the writer committed lines').toBeGreaterThan(0)
      if (ITERATIONS >= 10) expect(everything.tickets.length, 'the writer committed tickets').toBeGreaterThan(0)
      passed = true
    },
    // About 0.7 s per iteration on a laptop; generous for a slow CI disk (synchronous=FULL fsyncs).
    120_000 + ITERATIONS * 5_000
  )
})
