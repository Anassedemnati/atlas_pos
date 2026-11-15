import type { AtlasEvent } from '@shared/dto'
import type { DomainEvent, DomainEventType } from '../../application/events'
import type { EventBus } from '../../application/ports'

/** Every domain event; forwarded to the windows as they are. */
const DOMAIN_EVENT_TYPES = [
  'ticket.closed',
  'order.changed',
  'order.sent',
  'day.closed',
  'settings.changed',
  'catalog.changed',
  'backup.status',
  'print.status'
] as const satisfies readonly DomainEventType[]

// Fails to compile when a domain event is added without being listed above.
const everyEventListed: [Exclude<DomainEventType, (typeof DOMAIN_EVENT_TYPES)[number]>] extends [never] ? true : false = true
void everyEventListed

/** The renderer's view of a domain event (compile-time check that the shared mirror still fits). */
const toAtlasEvent = (event: DomainEvent): AtlasEvent => event

/** Sends every domain event of the bus to `send` (all the application windows). Returns the unsubscribe. */
export function forwardEvents(bus: EventBus, send: (event: AtlasEvent) => void): () => void {
  const unsubscribes = DOMAIN_EVENT_TYPES.map((type) => bus.subscribe(type, (event) => send(toAtlasEvent(event))))
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
}
