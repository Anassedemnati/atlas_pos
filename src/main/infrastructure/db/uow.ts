import type { DomainEvent } from '../../application/events'
import type { Clock, EventBus } from '../../application/ports'
import type { Database } from './connection'

export interface Tx {
  readonly db: Database
  readonly clock: Clock
  /** Events to publish once, and only if, the transaction commits. */
  readonly events: DomainEvent[]
}

export interface UnitOfWork {
  /** One use case = one transaction. Rethrows whatever `fn` throws, after rolling back. */
  run<T>(fn: (tx: Tx) => T): T
}

export function createUnitOfWork(db: Database, clock: Clock, bus: EventBus): UnitOfWork {
  return {
    run<T>(fn: (tx: Tx) => T): T {
      // better-sqlite3 would turn a nested transaction into a savepoint, and the inner run would
      // then publish its events before the outer commit. Use cases must be composed in one run.
      if (db.inTransaction) throw new Error('UnitOfWork.run: nested run() is not supported')

      const tx: Tx = { db, clock, events: [] }
      // IMMEDIATE takes the write lock up front (no SQLITE_BUSY upgrade halfway through).
      const result = db.transaction(() => fn(tx)).immediate()
      // Committed. Nothing below can undo it, and publish() does not throw.
      for (const event of tx.events) bus.publish(event)
      return result
    }
  }
}
