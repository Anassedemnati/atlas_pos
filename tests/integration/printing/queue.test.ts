import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus, type DomainEvent } from '../../../src/main/application/events'
import type { PrintJob } from '../../../src/main/application/ports'
import { createUnitOfWork, type UnitOfWork } from '../../../src/main/infrastructure/db/uow'
import { createPrintQueue, type PrintQueue } from '../../../src/main/infrastructure/printing/queue'
import { PermanentPrintError } from '../../../src/main/infrastructure/printing/types'
import { manualClock, manualScheduler, type ManualClock } from '../../helpers/backup'
import { tempDb, type TempDb } from '../../helpers/db'
import { addPrinter, jobRows } from '../../helpers/printing'

interface Sent {
  jobId: string
  printerId: string
  kind: string
  attempt: number
  payload: unknown
}

let t: TempDb
let clock: ManualClock
let scheduler: ReturnType<typeof manualScheduler>
let uow: UnitOfWork
let events: DomainEvent[]
let sent: Sent[]
let queue: PrintQueue
/** What the fake driver does for a printer: throws while this returns an Error. */
let failures: (printerId: string, attempt: number) => Error | undefined
/** Printers whose driver never answers (a device file blocked on a printer out of paper). */
let hung: Set<string>

const receiptJob = (over: Partial<PrintJob> = {}): PrintJob => ({ target: { role: 'receipt' }, kind: 'receipt', payload: { ticketId: 't1' }, ...over })
const enqueue = (job: PrintJob = receiptJob()): void => uow.run((tx) => queue.enqueue(tx, job))
const statusOf = (): string[] => jobRows(t.db).map((r) => r.status)
/** Waits (on the real clock, a few turns of the event loop) until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}
/** Moves time, lets the worker finish, and runs the timer it armed for "now" (a retry that fell due). */
async function pass(ms: number): Promise<void> {
  scheduler.advance(ms)
  await queue.idle()
  scheduler.advance(0)
  await queue.idle()
}

beforeEach(() => {
  t = tempDb()
  clock = manualClock('2026-10-22T10:00:00.000Z')
  scheduler = manualScheduler(clock)
  const bus = createEventBus()
  events = []
  bus.subscribe('print.status', (e) => events.push(e))
  uow = createUnitOfWork(t.db, clock, bus)
  sent = []
  failures = () => undefined
  hung = new Set()
  queue = createPrintQueue({
    db: t.db,
    clock,
    eventBus: bus,
    schedule: scheduler.schedule,
    log: () => undefined,
    send: async (job, printer) => {
      sent.push({ jobId: job.id, printerId: printer.id, kind: job.kind, attempt: job.attempts, payload: job.payload })
      if (hung.has(printer.id)) await new Promise(() => undefined)
      const error = failures(printer.id, job.attempts)
      if (error) throw error
    }
  })
  addPrinter(t.db, { id: 'p-caisse', name: 'Caisse', role: 'receipt' })
})

afterEach(() => {
  queue.stop()
  t.cleanup()
})

describe('enqueue', () => {
  it('writes a pending row in the caller transaction and nothing prints before the commit', () => {
    queue.start()
    uow.run((tx) => {
      queue.enqueue(tx, receiptJob())
      expect(jobRows(t.db)).toHaveLength(1)
      expect(sent).toHaveLength(0)
    })
    expect(jobRows(t.db)).toMatchObject([{ printer_id: 'p-caisse', kind: 'receipt', status: 'pending', attempts: 0, payload: { ticketId: 't1' } }])
  })

  it('leaves no row when the transaction rolls back, and prints nothing', async () => {
    queue.start()
    expect(() =>
      uow.run((tx) => {
        queue.enqueue(tx, receiptJob())
        throw new Error('rolled back')
      })
    ).toThrow('rolled back')
    await queue.idle()
    expect(jobRows(t.db)).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('announces the pending job once the transaction is committed', () => {
    enqueue()
    expect(events).toEqual([{ type: 'print.status', printerId: 'p-caisse', status: 'pending' }])
  })

  it('writes one row per active printer of the role, in a stable order, and none for an inactive one', () => {
    addPrinter(t.db, { id: 'p-b', name: 'Caisse 2', role: 'receipt' })
    addPrinter(t.db, { id: 'p-c', name: 'Vieille', role: 'receipt', active: false })
    addPrinter(t.db, { id: 'p-k', name: 'Cuisine', role: 'kitchen' })
    enqueue()
    expect(jobRows(t.db).map((r) => r.printer_id)).toEqual(['p-b', 'p-caisse'])
  })

  it('uses the printer it is given, whatever its role, and nothing when it does not exist', () => {
    addPrinter(t.db, { id: 'p-k', name: 'Cuisine', role: 'kitchen' })
    enqueue(receiptJob({ target: { printerId: 'p-k' } }))
    enqueue(receiptJob({ target: { printerId: 'nope' } }))
    expect(jobRows(t.db).map((r) => r.printer_id)).toEqual(['p-k'])
  })

  it('writes nothing and does not throw when no printer matches (a business transaction never fails over printing)', () => {
    expect(() => enqueue(receiptJob({ target: { role: 'bar' } }))).not.toThrow()
    expect(jobRows(t.db)).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it('does not throw for a payload it cannot read either', () => {
    addPrinter(t.db, { id: 'p-k', name: 'Cuisine', role: 'kitchen' })
    expect(() => enqueue({ target: { role: 'kitchen' }, kind: 'kitchen', payload: { orderId: 'missing', lineIds: ['x'] } })).not.toThrow()
    expect(() => enqueue({ target: { role: 'kitchen' }, kind: 'kitchen', payload: null })).not.toThrow()
    expect(jobRows(t.db)).toHaveLength(0)
  })
})

describe('the worker', () => {
  it('prints a committed job: printing, then done, announcing each step', async () => {
    queue.start()
    enqueue()
    await queue.idle()
    expect(sent).toMatchObject([{ printerId: 'p-caisse', kind: 'receipt', attempt: 1 }])
    expect(jobRows(t.db)).toMatchObject([{ status: 'done', attempts: 1, error: null }])
    expect(events.map((e) => (e as { status: string }).status)).toEqual(['pending', 'printing', 'done'])
  })

  it('marks the job printing before it calls the driver', async () => {
    let seen: string[] = []
    queue.stop()
    queue = createPrintQueue({
      db: t.db,
      clock,
      eventBus: createEventBus(),
      schedule: scheduler.schedule,
      log: () => undefined,
      send: async () => {
        seen = statusOf()
      }
    })
    queue.start()
    uow.run((tx) => queue.enqueue(tx, receiptJob()))
    queue.wake()
    await queue.idle()
    expect(seen).toEqual(['printing'])
  })

  it('does nothing until it is started, and picks the jobs waiting when it starts', async () => {
    enqueue()
    await queue.idle()
    expect(sent).toHaveLength(0)
    queue.start()
    await queue.idle()
    expect(sent).toHaveLength(1)
  })

  it('does not print after stop(), and resumes on start()', async () => {
    queue.start()
    queue.stop()
    enqueue()
    await queue.idle()
    expect(statusOf()).toEqual(['pending'])
    queue.start()
    await queue.idle()
    expect(statusOf()).toEqual(['done'])
  })

  it('retries a failing driver with the backoff 2 s, 5 s, 15 s: two failures then success is done after 3 attempts', async () => {
    failures = (_, attempt) => (attempt < 3 ? new Error(`paper out (${attempt})`) : undefined)
    queue.start()
    enqueue()
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', attempts: 1, error: 'paper out (1)' }])

    scheduler.advance(1999)
    await queue.idle()
    expect(sent).toHaveLength(1)
    scheduler.advance(1)
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', attempts: 2, error: 'paper out (2)' }])

    scheduler.advance(4999)
    await queue.idle()
    expect(sent).toHaveLength(2)
    scheduler.advance(1)
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ status: 'done', attempts: 3, error: null }])
    expect(sent.map((s) => s.attempt)).toEqual([1, 2, 3])
    expect(events.map((e) => (e as { status: string }).status)).toEqual(['pending', 'printing', 'failed', 'printing', 'failed', 'printing', 'done'])
  })

  it('gives up after the third retry: four failures leave the job failed with the error', async () => {
    failures = (_, attempt) => new Error(`ECONNREFUSED ${attempt}`)
    queue.start()
    enqueue()
    for (const wait of [0, 2000, 5000, 15000]) await pass(wait)
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', attempts: 4, error: 'ECONNREFUSED 4' }])
    await pass(10 * 60 * 1000)
    expect(sent).toHaveLength(4)
  })

  it('records the code of a system error with its message', async () => {
    failures = () => Object.assign(new Error('connect ECONNREFUSED 192.168.1.50:9100'), { code: 'ECONNREFUSED' })
    queue.start()
    enqueue()
    await queue.idle()
    expect(jobRows(t.db)[0]!.error).toBe('ECONNREFUSED: connect ECONNREFUSED 192.168.1.50:9100')
  })

  it('gives up at once on a failure retrying cannot cure', async () => {
    failures = () => new PermanentPrintError('unsupported_kind', 'no template for prebill')
    queue.start()
    enqueue()
    await queue.idle()
    scheduler.advance(60_000)
    await queue.idle()
    expect(sent).toHaveLength(1)
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', attempts: 4, error: 'unsupported_kind: no template for prebill' }])
  })

  it('fails a job whose printer is gone or switched off, instead of throwing', async () => {
    enqueue()
    t.db.prepare('UPDATE printers SET active = 0').run()
    queue.start()
    await queue.idle()
    expect(sent).toHaveLength(0)
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', attempts: 1, error: 'printer_unavailable' }])
    t.db.prepare('UPDATE printers SET active = 1').run()
    scheduler.advance(2000)
    await queue.idle()
    expect(statusOf()).toEqual(['done'])
  })

  it('survives a driver that throws synchronously', async () => {
    queue.stop()
    queue = createPrintQueue({
      db: t.db,
      clock,
      eventBus: createEventBus(),
      schedule: scheduler.schedule,
      log: () => undefined,
      send: () => {
        throw new Error('boom')
      }
    })
    queue.start()
    uow.run((tx) => queue.enqueue(tx, receiptJob()))
    queue.wake()
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ status: 'failed', error: 'boom' }])
  })

  it('does not let a failing printer hold up another', async () => {
    addPrinter(t.db, { id: 'p-cuisine', name: 'Cuisine', role: 'kitchen' })
    failures = (printerId) => (printerId === 'p-cuisine' ? new Error('offline') : undefined)
    queue.start()
    enqueue(receiptJob({ target: { printerId: 'p-cuisine' } }))
    enqueue()
    await queue.idle()
    expect(jobRows(t.db).map((r) => [r.printer_id, r.status])).toEqual([
      ['p-cuisine', 'failed'],
      ['p-caisse', 'done']
    ])
  })

  it('does not let a printer that never answers hold up another: a job on the other printer prints, retries included', async () => {
    addPrinter(t.db, { id: 'p-cuisine', name: 'Cuisine', role: 'kitchen' })
    hung.add('p-cuisine')
    let call = 0
    failures = (printerId) => (printerId === 'p-caisse' && ++call === 1 ? new Error('jam') : undefined)
    queue.start()
    enqueue(receiptJob({ target: { printerId: 'p-cuisine' } }))
    enqueue()
    // the cash printer fails once, and its retry is timed while the other printer is still stuck
    await until(() => statusOf()[1] === 'failed')
    expect(statusOf()[0]).toBe('printing')
    scheduler.advance(2000)
    await until(() => statusOf()[1] === 'done')
    // and a job queued later still goes through
    enqueue()
    await until(() => statusOf()[2] === 'done')
    expect(statusOf()).toEqual(['printing', 'done', 'done'])
  })

  it('stops a printer, instead of spinning, when it cannot even write the job state; the poll tries again', async () => {
    const logged: string[] = []
    queue.stop()
    queue = createPrintQueue({
      db: t.db,
      clock,
      eventBus: createEventBus(),
      schedule: scheduler.schedule,
      log: (event) => logged.push(event),
      send: async (job, printer) => void sent.push({ jobId: job.id, printerId: printer.id, kind: job.kind, attempt: job.attempts, payload: job.payload })
    })
    t.db.exec("CREATE TRIGGER disk_full BEFORE UPDATE ON print_jobs WHEN NEW.status = 'printing' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END")
    uow.run((tx) => queue.enqueue(tx, receiptJob()))
    queue.start()
    // Returns at once: a runner stuck in a loop would never let `idle` resolve.
    await queue.idle()
    expect(statusOf()).toEqual(['pending'])
    expect(sent).toHaveLength(0)
    expect(logged).toEqual(['print.state_failed'])

    t.db.exec('DROP TRIGGER disk_full')
    scheduler.advance(5000)
    await queue.idle()
    expect(statusOf()).toEqual(['done'])
    expect(logged).toEqual(['print.state_failed'])
  })

  it('keeps the order of one printer: a job waits behind an earlier one that is being retried', async () => {
    let call = 0
    failures = () => (++call === 1 ? new Error('jam') : undefined)
    queue.start()
    enqueue(receiptJob({ payload: { ticketId: 'first' } }))
    enqueue(receiptJob({ payload: { ticketId: 'second' } }))
    await queue.idle()
    expect(statusOf()).toEqual(['failed', 'pending'])
    scheduler.advance(2000)
    await queue.idle()
    expect(statusOf()).toEqual(['done', 'done'])
    expect(sent.map((s) => (jobRows(t.db).find((r) => r.id === s.jobId)!.payload as { ticketId: string }).ticketId)).toEqual(['first', 'first', 'second'])
  })

  it('does not hold a printer behind a job that has given up', async () => {
    let dead = true
    failures = () => (dead ? new Error('dead') : undefined)
    queue.start()
    enqueue(receiptJob({ payload: { ticketId: 'first' } }))
    for (const wait of [0, 2000, 5000, 15000]) await pass(wait)
    expect(statusOf()).toEqual(['failed'])
    dead = false
    enqueue(receiptJob({ payload: { ticketId: 'second' } }))
    await queue.idle()
    expect(statusOf()).toEqual(['failed', 'done'])
  })

  it('picks up a job inserted behind its back at the next poll', async () => {
    queue.start()
    await queue.idle()
    t.db
      .prepare("INSERT INTO print_jobs (id, printer_id, kind, payload_json, created_at, updated_at) VALUES ('j1', 'p-caisse', 'receipt', '{}', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z')")
      .run()
    scheduler.advance(5000)
    await queue.idle()
    expect(statusOf()).toEqual(['done'])
  })
})

describe('start-up recovery', () => {
  const insertJob = (id: string, kind = 'receipt', status = 'printing', payload: unknown = {}): void => {
    t.db
      .prepare("INSERT INTO print_jobs (id, printer_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, 'p-caisse', ?, ?, ?, 1, '2026-10-22T09:59:00.000Z', '2026-10-22T09:59:00.000Z')")
      .run(id, kind, JSON.stringify(payload), status)
  }
  const insertPrinting = (id: string): void => insertJob(id)

  it('turns a job left printing into uncertain, tells the UI, and does not print it again', async () => {
    insertPrinting('j1')
    queue.start()
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ id: 'j1', status: 'uncertain', attempts: 1 }])
    expect(events).toEqual([{ type: 'print.status', printerId: 'p-caisse', status: 'uncertain' }])
    expect(sent).toHaveLength(0)
    scheduler.advance(60_000)
    await queue.idle()
    expect(sent).toHaveLength(0)
    expect(queue.list()).toMatchObject([{ id: 'j1', printerName: 'Caisse', kind: 'receipt', status: 'uncertain' }])
  })

  it('does not hold the printer: later jobs print while an uncertain one waits for a decision', async () => {
    insertPrinting('j1')
    queue.start()
    enqueue()
    await queue.idle()
    expect(statusOf()).toEqual(['uncertain', 'done'])
  })

  it('reprintJob sends a failed job again as it was, with fresh attempts: it never printed', async () => {
    failures = () => new Error('offline')
    queue.start()
    enqueue(receiptJob({ payload: { ticketId: 't1' } }))
    await queue.idle()
    const id = jobRows(t.db)[0]!.id
    failures = () => undefined
    expect(queue.reprintJob(id)).toMatchObject({ ok: true, value: { id, status: 'pending', attempts: 0, error: null } })
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ id, status: 'done', attempts: 1, error: null, payload: { ticketId: 't1' } }])
    // not marked as a duplicate: nothing came out the first time
    expect(sent.at(-1)!.payload).toEqual({ ticketId: 't1' })
  })

  it('reprintJob sends an uncertain kitchen ticket again, marked as a reprint since it may have printed', async () => {
    insertJob('j1', 'kitchen', 'printing', { orderId: 'o1', lineIds: ['l1'], ticket: { lines: [] } })
    queue.start()
    await queue.idle()
    expect(queue.reprintJob('j1')).toMatchObject({ ok: true, value: { id: 'j1', status: 'pending', attempts: 0 } })
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ id: 'j1', status: 'done' }])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toEqual({ orderId: 'o1', lineIds: ['l1'], ticket: { lines: [] }, reprint: true })
  })

  it('reprintJob leaves an uncertain receipt to the reprintTicket use case: DUPLICATA, the counter, the permission', async () => {
    insertPrinting('j1')
    queue.start()
    await queue.idle()
    expect(queue.reprintJob('j1')).toMatchObject({ ok: false, error: { code: 'print_job_not_reprintable', params: { reason: 'use_ticket_reprint' } } })
    expect(statusOf()).toEqual(['uncertain'])
    expect(sent).toHaveLength(0)
    // the cashier prints the duplicate through the use case, then dismisses the doubt
    expect(queue.dismissJob('j1')).toMatchObject({ ok: true })
  })

  it('reprintJob never sends a drawer pulse again, whatever its state: opening the drawer is a permissioned, logged action', async () => {
    for (const status of ['failed', 'uncertain', 'done']) {
      insertJob(`drawer-${status}`, 'drawer', status)
      expect(queue.reprintJob(`drawer-${status}`), status).toMatchObject({ ok: false, error: { code: 'print_job_not_reprintable', params: { reason: 'drawer' } } })
    }
    // nothing was queued again
    expect(statusOf()).toEqual(['failed', 'uncertain', 'done'])
    expect(jobRows(t.db).map((r) => r.attempts)).toEqual([1, 1, 1])
  })

  it('reprintJob refuses a job that has printed', async () => {
    queue.start()
    enqueue()
    await queue.idle()
    const id = jobRows(t.db)[0]!.id
    expect(queue.reprintJob(id)).toMatchObject({ ok: false, error: { code: 'print_job_not_reprintable', params: { reason: 'printed' } } })
    await queue.idle()
    expect(sent).toHaveLength(1)
  })

  it('dismissJob takes the job off the list without printing it', async () => {
    insertPrinting('j1')
    queue.start()
    await queue.idle()
    expect(queue.dismissJob('j1')).toMatchObject({ ok: true, value: { id: 'j1', status: 'done' } })
    expect(queue.list()).toEqual([])
    expect(jobRows(t.db)).toMatchObject([{ status: 'done', error: 'dismissed' }])
    expect(sent).toHaveLength(0)
  })

  it('refuses to reprint what is pending or printing, to dismiss what is not waiting for a decision, and unknown ids', async () => {
    enqueue()
    const pending = jobRows(t.db)[0]!.id
    expect(queue.reprintJob(pending)).toMatchObject({ ok: false, error: { code: 'print_job_busy' } })
    expect(queue.dismissJob(pending)).toMatchObject({ ok: false, error: { code: 'print_job_not_dismissable' } })
    expect(queue.reprintJob('nope')).toMatchObject({ ok: false, error: { code: 'print_job_not_found' } })
    expect(queue.dismissJob('nope')).toMatchObject({ ok: false, error: { code: 'print_job_not_found' } })
  })
})

describe('list', () => {
  it('lists the failed and uncertain jobs by default, oldest first, with the printer name', async () => {
    failures = () => new Error('offline')
    queue.start()
    enqueue()
    await queue.idle()
    expect(queue.list()).toMatchObject([{ printerId: 'p-caisse', printerName: 'Caisse', status: 'failed', attempts: 1, error: 'offline' }])
    expect(queue.list(['done'])).toEqual([])
    expect(queue.list(['failed', 'done'])).toHaveLength(1)
  })

  it('names a printer that no longer exists by its id', async () => {
    t.db.prepare("INSERT INTO print_jobs (id, printer_id, kind, payload_json, status, created_at, updated_at) VALUES ('j1', 'gone', 'receipt', '{}', 'failed', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z')").run()
    expect(queue.list()).toMatchObject([{ printerId: 'gone', printerName: null }])
  })
})
