import type { EventBus } from './ports'

/**
 * Placeholder: Task 4 narrows this into the union of real events
 * (`ticket.closed`, `order.changed`, ...). Nothing else may depend on the loose shape.
 */
export type DomainEvent = { type: string; [key: string]: unknown }

type Handler = (event: DomainEvent) => void

const reportHandlerError = (error: unknown, event: DomainEvent): void => {
  console.error(`[event-bus] a subscriber of "${event.type}" threw`, error)
}

/**
 * In-memory, synchronous event bus. `publish` never throws: events are published after the
 * work they describe is committed, so a failing subscriber must not look like a failed use case.
 * Its error goes to `onHandlerError` and the remaining subscribers still run.
 */
export function createEventBus(
  onHandlerError: (error: unknown, event: DomainEvent) => void = reportHandlerError
): EventBus {
  // One entry object per subscription, so subscribing the same function twice gives two
  // independent subscriptions.
  const subscriptions = new Map<string, Set<{ handler: Handler }>>()

  return {
    publish(event) {
      const subscribed = subscriptions.get(event.type)
      if (!subscribed) return
      for (const { handler } of [...subscribed]) {
        try {
          handler(event)
        } catch (error) {
          onHandlerError(error, event)
        }
      }
    },
    subscribe(type, handler) {
      let subscribed = subscriptions.get(type)
      if (!subscribed) {
        subscribed = new Set()
        subscriptions.set(type, subscribed)
      }
      const entry = { handler }
      subscribed.add(entry)
      return () => {
        subscribed.delete(entry)
      }
    }
  }
}
