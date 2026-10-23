import type { DomainEvent } from './events'

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
  /** Returns the function that removes this subscription. */
  subscribe(type: string, handler: (e: DomainEvent) => void): () => void
}
