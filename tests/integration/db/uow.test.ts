import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/main/application/events'
import type { DomainEvent } from '../../../src/main/application/events'
import type { EventBus } from '../../../src/main/application/ports'
import { createUnitOfWork, type UnitOfWork } from '../../../src/main/infrastructure/db/uow'
import { fixedClock } from '../../helpers/clock'
import { tempDb, type TempDb } from '../../helpers/db'

describe('unit of work', () => {
  let t: TempDb
  let uow: UnitOfWork
  let published: DomainEvent[]
  let bus: EventBus

  beforeEach(() => {
    t = tempDb()
    published = []
    bus = createEventBus() // fresh per test: subscriptions must not leak between tests
    uow = createUnitOfWork(t.db, fixedClock(), bus)
  })
  afterEach(() => t.cleanup())

  const subscribeAll = (...types: string[]): void => {
    for (const type of types) bus.subscribe(type, (e) => published.push(e))
  }
  const settingCount = (): number =>
    (t.db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n
  const insertSetting = (db: typeof t.db, key: string): void => {
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, '1', 'now')").run(key)
  }

  it('returns what the function returns and commits its writes', () => {
    const result = uow.run((tx) => {
      insertSetting(tx.db, 'a')
      return 'done'
    })
    expect(result).toBe('done')
    expect(settingCount()).toBe(1)
    expect(t.db.inTransaction).toBe(false)
  })

  it('hands the function the db, the clock and an empty events list', () => {
    uow.run((tx) => {
      expect(tx.db).toBe(t.db)
      expect(tx.clock.now().toISOString()).toBe('2026-10-22T10:00:00.000Z')
      expect(tx.events).toEqual([])
    })
  })

  it('dispatches tx.events after commit, in order', () => {
    subscribeAll('order.changed', 'ticket.closed')
    uow.run((tx) => {
      tx.events.push({ type: 'order.changed', orderId: 'o1' }, { type: 'ticket.closed', ticketId: 't1' })
      expect(published).toEqual([]) // nothing leaves before the commit
    })
    expect(published).toEqual([
      { type: 'order.changed', orderId: 'o1' },
      { type: 'ticket.closed', ticketId: 't1' }
    ])
  })

  it('dispatches only once the data is committed and visible to another connection', () => {
    const other = new Database(t.path, { readonly: true })
    try {
      const seenByHandler: { inTransaction: boolean; visibleToOtherConnection: number }[] = []
      bus.subscribe('order.changed', () => {
        seenByHandler.push({
          inTransaction: t.db.inTransaction,
          visibleToOtherConnection: (other.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n
        })
      })
      uow.run((tx) => {
        insertSetting(tx.db, 'a')
        tx.events.push({ type: 'order.changed', orderId: 'o1' })
      })
      expect(seenByHandler).toEqual([{ inTransaction: false, visibleToOtherConnection: 1 }])
    } finally {
      other.close()
    }
  })

  it('rolls back and dispatches nothing when the function throws', () => {
    subscribeAll('order.changed')
    expect(() =>
      uow.run((tx) => {
        insertSetting(tx.db, 'a')
        tx.events.push({ type: 'order.changed', orderId: 'o1' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(settingCount()).toBe(0)
    expect(published).toEqual([])
    expect(t.db.inTransaction).toBe(false)
  })

  it('rolls back and dispatches nothing when the commit itself fails', () => {
    subscribeAll('order.changed')
    t.db.pragma('foreign_keys = ON')
    // A deferred foreign key violation is only detected at COMMIT.
    t.db.exec(
      'CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (p TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);'
    )
    expect(() =>
      uow.run((tx) => {
        tx.db.prepare("INSERT INTO child (p) VALUES ('nope')").run()
        tx.events.push({ type: 'order.changed', orderId: 'o1' })
      })
    ).toThrow(/FOREIGN KEY/)
    expect(published).toEqual([])
    expect(t.db.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 0 })
  })

  it('takes the write lock when it starts (BEGIN IMMEDIATE), before any write', () => {
    const other = new Database(t.path, { timeout: 0 })
    try {
      uow.run(() => {
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i)
      })
      other.exec('BEGIN IMMEDIATE') // free again after the commit
      other.exec('ROLLBACK')
    } finally {
      other.close()
    }
  })

  it('does not let a failing subscriber turn a committed run into a failure', () => {
    const errors: unknown[] = []
    const quietBus = createEventBus((error) => errors.push(error))
    quietBus.subscribe('order.changed', () => {
      throw new Error('subscriber bug')
    })
    const quietUow = createUnitOfWork(t.db, fixedClock(), quietBus)
    expect(() =>
      quietUow.run((tx) => {
        insertSetting(tx.db, 'a')
        tx.events.push({ type: 'order.changed', orderId: 'o1' })
      })
    ).not.toThrow()
    expect(settingCount()).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it('refuses a nested run (it would publish before the outer commit) and rolls the outer one back', () => {
    subscribeAll('order.changed')
    expect(() =>
      uow.run((tx) => {
        insertSetting(tx.db, 'a')
        tx.events.push({ type: 'order.changed', orderId: 'o1' })
        uow.run(() => undefined)
      })
    ).toThrow(/nested/)
    expect(settingCount()).toBe(0)
    expect(published).toEqual([])
  })

  it('is reusable after a failed run', () => {
    expect(() =>
      uow.run(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(uow.run(() => 42)).toBe(42)
  })
})
