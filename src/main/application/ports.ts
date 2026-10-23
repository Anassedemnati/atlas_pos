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
