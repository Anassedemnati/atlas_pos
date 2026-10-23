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

const receiptJob = (over: Partial<PrintJob> = {}): PrintJob => ({ target: { role: 'receipt' }, kind: 'receipt', payload: { ticketId: 't1' }, ...over })
const enqueue = (job: PrintJob = receiptJob()): void => uow.run((tx) => queue.enqueue(tx, job))
const statusOf = (): string[] => jobRows(t.db).map((r) => r.status)
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
  queue = createPrintQueue({
    db: t.db,
    clock,
    eventBus: bus,
    schedule: scheduler.schedule,
    log: () => undefined,
    send: async (job, printer) => {
      sent.push({ jobId: job.id, printerId: printer.id, kind: job.kind, attempt: job.attempts })
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
  const insertPrinting = (id: string): void => {
    t.db
      .prepare("INSERT INTO print_jobs (id, printer_id, kind, payload_json, status, attempts, created_at, updated_at) VALUES (?, 'p-caisse', 'receipt', '{}', 'printing', 1, '2026-10-22T09:59:00.000Z', '2026-10-22T09:59:00.000Z')")
      .run(id)
  }

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

  it('reprintJob puts an uncertain or failed job back in the queue with fresh attempts', async () => {
    insertPrinting('j1')
    queue.start()
    await queue.idle()
    const result = queue.reprintJob('j1')
    expect(result).toMatchObject({ ok: true, value: { id: 'j1', status: 'pending', attempts: 0 } })
    await queue.idle()
    expect(jobRows(t.db)).toMatchObject([{ id: 'j1', status: 'done', attempts: 1, error: null }])
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

  it('lets a finished job be printed again', async () => {
    queue.start()
    enqueue()
    await queue.idle()
    const id = jobRows(t.db)[0]!.id
    expect(queue.reprintJob(id)).toMatchObject({ ok: true })
    await queue.idle()
    expect(sent).toHaveLength(2)
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
