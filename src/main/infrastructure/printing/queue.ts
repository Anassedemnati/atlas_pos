import { newId } from '@shared/ids'
import type { AppError, Result } from '@shared/result'
import { z } from 'zod'
import type { Clock, EventBus, PrintJob, PrintJobKind, PrintSpooler } from '../../application/ports'
import type { Schedule } from '../backup/engine'
import type { Database } from '../db/connection'
import type { Tx } from '../db/uow'
import { readKitchenSource, type KitchenTicket } from './kitchen-source'
import { printersForTarget, readPrinter, readRouting, routeKitchen } from './router'
import { PermanentPrintError, type PrinterRow } from './types'

export type PrintStatus = 'pending' | 'printing' | 'done' | 'failed' | 'uncertain'

/** A queued job as the worker hands it to `send`. `attempts` counts this one. */
export interface PrintJobRow {
  id: string
  printerId: string
  kind: PrintJobKind
  payload: unknown
  attempts: number
}

/** A job as the UI lists it (failures and the jobs to decide about after a restart). */
export interface PrintJobInfo {
  id: string
  printerId: string
  /** Null when the printer has been deleted since. */
  printerName: string | null
  kind: PrintJobKind
  status: PrintStatus
  attempts: number
  error: string | null
  createdAt: string
  updatedAt: string
}

export type PrintLog = (event: string, data?: Record<string, unknown>) => void

export interface PrintQueueDeps {
  db: Database
  clock: Clock
  eventBus: EventBus
  /**
   * Renders and sends one job to its printer; rejects with the reason it was not printed (a
   * `PermanentPrintError` when retrying cannot help). A printer that is gone or off never reaches it.
   */
  send(job: PrintJobRow, printer: PrinterRow): Promise<void>
  log?: PrintLog
  schedule?: Schedule
  /** Waits before the 2nd, 3rd and 4th attempt. Default 2 s, 5 s, 15 s. */
  backoffMs?: readonly number[]
  /** How often the worker looks for work nobody announced. Default 5 s. */
  pollIntervalMs?: number
}

export interface PrintQueue extends PrintSpooler {
  /**
   * Inside the business transaction: one `pending` row per physical printer the job resolves to (the printer
   * it names, or the active printers of its role; kitchen jobs split by category). A kitchen ticket's content
   * is frozen into the row. Announces `pending` once the transaction commits. Writes nothing, and never throws,
   * when there is no printer or the payload is unreadable: printing must not undo a sale.
   */
  enqueue(tx: Tx, job: PrintJob): void
  /** Turns the jobs left `printing` by a crash into `uncertain`, then starts printing what is pending. */
  start(): void
  /** Stops picking up jobs; a job already being sent finishes. Each printer is worked on by its own runner. */
  stop(): void
  /** Looks for due jobs now. */
  wake(): void
  /** Resolves when no job is being sent and none is due (for tests: it waits for a driver that never answers). */
  idle(): Promise<void>
  /** Jobs in these statuses, oldest first (default: the ones needing attention, `failed` and `uncertain`). */
  list(statuses?: PrintStatus[]): PrintJobInfo[]
  /**
   * Puts a job back in the queue with fresh attempts, for what a retry may do without a person's authority:
   * - a `failed` job (it never printed) is sent again as it was;
   * - an `uncertain` kitchen, Z or invoice job (it may have printed) is sent again, a kitchen ticket marked
   *   RÉIMPRESSION;
   * - a `done` job, an `uncertain` receipt and any drawer pulse are refused (`print_job_not_reprintable`, with
   *   `params.reason`: `printed`, `use_ticket_reprint`, `drawer`). A receipt is printed again by the
   *   `reprintTicket` use case (DUPLICATA, counted, logged), a drawer opened by its own permissioned use case.
   */
  reprintJob(id: string): Result<PrintJobInfo>
  /** Takes a failed or uncertain job off the list without printing it (kept as `done`, error `dismissed`). */
  dismissJob(id: string): Result<PrintJobInfo>
}

const DEFAULT_BACKOFF_MS: readonly number[] = [2000, 5000, 15000]
const DEFAULT_POLL_MS = 5000
const MAX_ERROR_LENGTH = 500

const defaultSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

const KitchenPayload = z.object({ orderId: z.string().min(1), lineIds: z.array(z.string().min(1)).min(1) })

const isKitchen = (kind: PrintJobKind): boolean => kind === 'kitchen' || kind === 'kitchen-cancel'

interface DbJob {
  id: string
  printer_id: string
  kind: PrintJobKind
  payload_json: string
  status: PrintStatus
  attempts: number
  error: string | null
  created_at: string
  updated_at: string
}

/** What is stored for a failure: its code and message, or just the message. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  const text = typeof code === 'string' && code !== '' && code !== message ? `${code}: ${message}` : message
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text
}

const appError = (code: string, params?: Record<string, unknown>): AppError => ({
  code,
  messageKey: `errors.${code}`,
  ...(params ? { params } : {})
})

export function createPrintQueue(deps: PrintQueueDeps): PrintQueue {
  const { db, clock, eventBus } = deps
  const log: PrintLog = deps.log ?? (() => undefined)
  const schedule = deps.schedule ?? defaultSchedule
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS
  const maxAttempts = backoff.length + 1

  let started = false
  /** One runner per printer with work: a printer that is slow or hung holds up only itself. */
  const runners = new Map<string, Promise<void>>()
  /** Printers that were woken while their runner was busy: the runner looks again when it ends. */
  const woken = new Set<string>()
  /** A wake announced by an event, waiting for the next turn of the event loop (see `wakeSoon`). */
  let wakeQueued = false
  let timer: (() => void) | null = null
  let unsubscribe: (() => void) | null = null
  /** The earliest time a failed job waits for, as the runners that gave way to it saw it. */
  let nextRetryAt: number | null = null

  const nowIso = (): string => clock.now().toISOString()
  const announce = (printerId: string, status: PrintStatus): void => eventBus.publish({ type: 'print.status', printerId, status })

  // -- enqueue ------------------------------------------------------------------------------------------

  /** What to insert for a job: the printer and the payload each row carries. */
  function plan(tx: Tx, job: PrintJob): { printerId: string; payload: unknown }[] {
    if (isKitchen(job.kind) && job.target.printerId === undefined) {
      const parsed = KitchenPayload.safeParse(job.payload)
      if (!parsed.success) {
        log('print.payload_unreadable', { kind: job.kind })
        return []
      }
      const source = readKitchenSource(tx.db, tx.clock, parsed.data.orderId, parsed.data.lineIds)
      if (!source) {
        log('print.order_not_found', { kind: job.kind, orderId: parsed.data.orderId })
        return []
      }
      const routed = routeKitchen(source.lines, readRouting(tx.db))
      if (routed.size === 0) log('print.no_printer', { kind: job.kind, orderId: parsed.data.orderId })
      return [...routed].map(([printerId, lines]) => ({
        printerId,
        payload: {
          orderId: parsed.data.orderId,
          lineIds: lines.map((l) => l.id),
          ticket: { order: source.order, lines: lines.map(({ categoryId: _category, ...line }) => line) } satisfies KitchenTicket
        }
      }))
    }

    const printers = printersForTarget(tx.db, job.target)
    if (printers.length === 0) {
      log('print.no_printer', { kind: job.kind, target: job.target })
      return []
    }
    if (isKitchen(job.kind)) {
      // A kitchen job addressed to one printer prints everything on it.
      const parsed = KitchenPayload.safeParse(job.payload)
      const source = parsed.success ? readKitchenSource(tx.db, tx.clock, parsed.data.orderId, parsed.data.lineIds) : undefined
      if (!parsed.success || !source) {
        log('print.payload_unreadable', { kind: job.kind })
        return []
      }
      const lines = source.lines.map(({ categoryId: _category, ...line }) => line)
      return printers.map((p) => ({ printerId: p.id, payload: { ...parsed.data, ticket: { order: source.order, lines } satisfies KitchenTicket } }))
    }
    return printers.map((p) => ({ printerId: p.id, payload: job.payload }))
  }

  function enqueue(tx: Tx, job: PrintJob): void {
    try {
      const at = tx.clock.now().toISOString()
      for (const { printerId, payload } of plan(tx, job)) {
        tx.db
          .prepare('INSERT INTO print_jobs (id, printer_id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId(), printerId, job.kind, JSON.stringify(payload ?? null), at, at)
        tx.events.push({ type: 'print.status', printerId, status: 'pending' })
      }
    } catch (error) {
      log('print.enqueue_failed', { kind: job.kind, message: error instanceof Error ? error.message : String(error) })
    }
  }

  // -- the worker ---------------------------------------------------------------------------------------

  /** When a job may be tried: 0 now, a time after a failure, null never again (gave up). */
  function dueAt(job: DbJob): number | null {
    if (job.status === 'pending') return 0
    if (job.attempts >= maxAttempts) return null
    return Date.parse(job.updated_at) + backoff[Math.max(0, job.attempts - 1)]!
  }

  /** The oldest job of the printer still waiting its turn (pending, or failed with retries left). */
  function headOf(printerId: string): { job: DbJob; due: number } | undefined {
    const rows = db
      .prepare("SELECT * FROM print_jobs WHERE printer_id = ? AND status IN ('pending', 'failed') ORDER BY rowid")
      .all(printerId) as DbJob[]
    for (const job of rows) {
      const due = dueAt(job)
      if (due !== null) return { job, due }
    }
    return undefined
  }

  function setState(id: string, status: PrintStatus, attempts: number, error: string | null): void {
    db.prepare('UPDATE print_jobs SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?').run(status, attempts, error, nowIso(), id)
  }

  /**
   * Sends the job. Resolves false when its state could not even be written (the database is failing): nothing
   * was sent, the job is still waiting, and the runner must stop instead of trying again at once.
   */
  async function attempt(job: DbJob): Promise<boolean> {
    const attempts = job.attempts + 1
    try {
      setState(job.id, 'printing', attempts, null)
    } catch (error) {
      log('print.state_failed', { jobId: job.id, message: describeError(error) })
      return false
    }
    announce(job.printer_id, 'printing')

    let failure: unknown
    try {
      const printer = readPrinter(db, job.printer_id)
      if (!printer?.active) throw new Error('printer_unavailable')
      let payload: unknown
      try {
        payload = JSON.parse(job.payload_json)
      } catch {
        throw new PermanentPrintError('payload_unreadable')
      }
      await deps.send({ id: job.id, printerId: job.printer_id, kind: job.kind, payload, attempts }, printer)
    } catch (error) {
      failure = error ?? new Error('unknown error')
    }

    try {
      if (failure === undefined) {
        setState(job.id, 'done', attempts, null)
        announce(job.printer_id, 'done')
      } else {
        // A failure retrying cannot cure uses up the attempts at once.
        const spent = failure instanceof PermanentPrintError ? maxAttempts : attempts
        setState(job.id, 'failed', spent, describeError(failure))
        log('print.failed', { jobId: job.id, printerId: job.printer_id, attempts: spent, message: describeError(failure) })
        announce(job.printer_id, 'failed')
      }
    } catch (error) {
      // Left `printing`: after a restart it is `uncertain`, which is what it is.
      log('print.state_failed', { jobId: job.id, message: describeError(error) })
    }
    return true
  }

  /** Sends one printer's jobs, oldest first, until the next one is not due (or the database fails). */
  async function runPrinter(printerId: string): Promise<void> {
    try {
      while (started) {
        const head = headOf(printerId)
        if (!head) return
        if (head.due > clock.now().getTime()) {
          nextRetryAt = nextRetryAt === null ? head.due : Math.min(nextRetryAt, head.due)
          return
        }
        // The poll tries again later.
        if (!(await attempt(head.job))) return
      }
    } catch (error) {
      log('print.worker_failed', { printerId, message: describeError(error) })
    }
  }

  function startRunner(printerId: string): void {
    const runner: Promise<void> = runPrinter(printerId).finally(() => {
      if (runners.get(printerId) === runner) runners.delete(printerId)
      // Woken while busy: look again, but only when someone asked, so a runner that stopped on a failing
      // database does not restart itself in a loop.
      if (woken.delete(printerId) && started) startRunner(printerId)
      else if (started) armTimer()
    })
    runners.set(printerId, runner)
  }

  function armTimer(): void {
    timer?.()
    const wait = nextRetryAt === null ? pollMs : Math.min(pollMs, Math.max(0, nextRetryAt - clock.now().getTime()))
    timer = schedule(() => {
      timer = null
      nextRetryAt = null
      wake()
    }, wait)
  }

  /** Starts a runner for each printer with work waiting and none running; tells a busy one to look again. */
  function wake(): void {
    if (!started) return
    try {
      const printers = db.prepare("SELECT DISTINCT printer_id AS id FROM print_jobs WHERE status IN ('pending', 'failed')").all() as { id: string }[]
      for (const { id } of printers) {
        if (runners.has(id)) woken.add(id)
        else startRunner(id)
      }
    } catch (error) {
      log('print.worker_failed', { message: describeError(error) })
    }
    armTimer()
  }

  /**
   * `wake()` on the next turn of the event loop: a job queued in a use case is announced (after the commit) from
   * inside that use case's call, and the cashier's screen must not wait for the worker's first writes.
   */
  function wakeSoon(): void {
    if (!started || wakeQueued) return
    wakeQueued = true
    setImmediate(() => {
      wakeQueued = false
      wake()
    })
  }

  // -- control, listing, decisions ----------------------------------------------------------------------

  const toInfo = (row: DbJob & { printer_name: string | null }): PrintJobInfo => ({
    id: row.id,
    printerId: row.printer_id,
    printerName: row.printer_name,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

  const infoOf = (id: string): PrintJobInfo | undefined => {
    const row = db
      .prepare('SELECT j.*, p.name AS printer_name FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id WHERE j.id = ?')
      .get(id) as (DbJob & { printer_name: string | null }) | undefined
    return row ? toInfo(row) : undefined
  }

  return {
    enqueue,

    start() {
      if (started) return
      started = true
      unsubscribe = eventBus.subscribe('print.status', (e) => {
        if (e.status === 'pending') wakeSoon()
      })
      const stuck = db.prepare("SELECT id, printer_id FROM print_jobs WHERE status = 'printing' ORDER BY rowid").all() as { id: string; printer_id: string }[]
      if (stuck.length > 0) {
        db.prepare("UPDATE print_jobs SET status = 'uncertain', updated_at = ? WHERE status = 'printing'").run(nowIso())
        for (const job of stuck) announce(job.printer_id, 'uncertain')
      }
      wake()
    },

    stop() {
      started = false
      unsubscribe?.()
      unsubscribe = null
      timer?.()
      timer = null
    },

    wake,

    async idle() {
      for (;;) {
        if (runners.size > 0) await Promise.allSettled([...runners.values()])
        else if (wakeQueued) await new Promise<void>((resolve) => setImmediate(resolve))
        else return
      }
    },

    list(statuses = ['failed', 'uncertain']) {
      if (statuses.length === 0) return []
      const rows = db
        .prepare(
          `SELECT j.*, p.name AS printer_name FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
            WHERE j.status IN (${statuses.map(() => '?').join(',')}) ORDER BY j.rowid`
        )
        .all(...statuses) as (DbJob & { printer_name: string | null })[]
      return rows.map(toInfo)
    },

    reprintJob(id) {
      const job = infoOf(id)
      if (!job) return { ok: false, error: appError('print_job_not_found') }
      if (job.status === 'pending' || job.status === 'printing') return { ok: false, error: appError('print_job_busy') }
      const refuse = (reason: string): Result<PrintJobInfo> => ({ ok: false, error: appError('print_job_not_reprintable', { reason }) })
      if (job.kind === 'drawer') return refuse('drawer')
      if (job.status === 'done') return refuse('printed')
      if (job.status === 'uncertain' && job.kind === 'receipt') return refuse('use_ticket_reprint')

      db.transaction(() => {
        if (job.status === 'uncertain' && isKitchen(job.kind)) {
          // It may have printed: the copy says so.
          const row = db.prepare('SELECT payload_json FROM print_jobs WHERE id = ?').get(id) as { payload_json: string }
          let payload: unknown
          try {
            payload = JSON.parse(row.payload_json)
          } catch {
            payload = null
          }
          const marked = { ...(typeof payload === 'object' && payload !== null ? payload : {}), reprint: true }
          db.prepare('UPDATE print_jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(marked), id)
        }
        setState(id, 'pending', 0, null)
      })()
      const value = infoOf(id)!
      announce(job.printerId, 'pending')
      wake()
      return { ok: true, value }
    },

    dismissJob(id) {
      const job = infoOf(id)
      if (!job) return { ok: false, error: appError('print_job_not_found') }
      if (job.status !== 'failed' && job.status !== 'uncertain') return { ok: false, error: appError('print_job_not_dismissable') }
      setState(id, 'done', job.attempts, 'dismissed')
      announce(job.printerId, 'done')
      return { ok: true, value: infoOf(id)! }
    }
  }
}
