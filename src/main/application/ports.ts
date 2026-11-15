import type { Tx } from '../infrastructure/db/uow'
import type { DomainEvent, DomainEventOf, DomainEventType } from './events'

/** The only source of time for use cases and repositories (tests inject a fixed one). */
export interface Clock {
  now(): Date
}

export interface IdGen {
  next(): string
}

export interface EventBus {
  /** Must not throw: it is called after the work it announces has been committed. */
  publish(e: DomainEvent): void
  /** The handler receives the event narrowed to `type`. Returns the function that removes this subscription. */
  subscribe<T extends DomainEventType>(type: T, handler: (e: DomainEventOf<T>) => void): () => void
}

/** What a print job is for; Task 13's queue renders each kind. */
export type PrintJobKind = 'receipt' | 'kitchen' | 'kitchen-cancel' | 'drawer' | 'z' | 'prebill' | 'invoice'

export interface PrintJob {
  /** A given printer, or the printers of a role (kitchen jobs are routed by category in Task 13). */
  target: { printerId?: string; role?: 'receipt' | 'kitchen' | 'bar' }
  kind: PrintJobKind
  payload: unknown
}

/**
 * The print queue as the use cases see it. `enqueue` runs inside the use case's transaction (`tx`), so a
 * job exists if and only if the change it prints was committed.
 */
export interface PrintSpooler {
  enqueue(tx: Tx, job: PrintJob): void
}

/** Asks for a dated full backup (the Z closure). Must not throw; the promise never rejects. */
export interface FullBackupTrigger {
  runFull(kind: 'full', label?: string): Promise<unknown>
}
