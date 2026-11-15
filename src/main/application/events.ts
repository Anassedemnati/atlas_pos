import type { SettingKey } from '../domain/config/settings-registry'
import type { EventBus } from './ports'

/**
 * Everything the application announces after a commit. A subscriber reacts (refreshes a screen,
 * starts a backup); it never changes what the event describes.
 */
export type DomainEvent =
  | { type: 'ticket.closed'; ticketId: string }
  | { type: 'order.changed'; orderId: string }
  | { type: 'order.sent'; orderId: string; lineIds: string[] }
  | { type: 'day.closed'; dayId: string; zId: string }
  | { type: 'settings.changed'; keys: SettingKey[] }
  | { type: 'catalog.changed' }
  | { type: 'backup.status'; status: 'ok' | 'warning' | 'error' }
  | { type: 'print.status'; printerId: string; status: 'pending' | 'printing' | 'done' | 'failed' | 'uncertain' }

export type DomainEventType = DomainEvent['type']

/** The event with this `type`: `DomainEventOf<'order.sent'>` is `{ type; orderId; lineIds }`. */
export type DomainEventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>

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
      // Only events of `type` ever reach this handler, so it is safe to widen its parameter.
      const entry = { handler: handler as Handler }
      subscribed.add(entry)
      return () => {
        subscribed.delete(entry)
      }
    }
  }
}
