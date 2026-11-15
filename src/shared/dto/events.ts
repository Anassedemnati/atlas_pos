import type { OrderDto } from './orders'

// What the main process pushes to the windows (`window.atlas.on`). The domain events mirror the main
// process's `DomainEvent` (it checks at compile time that each one fits); `display.order` is sent to
// the customer display only.

export type AtlasEvent =
  | { type: 'ticket.closed'; ticketId: string }
  | { type: 'order.changed'; orderId: string }
  | { type: 'order.sent'; orderId: string; lineIds: string[] }
  | { type: 'day.closed'; dayId: string; zId: string }
  | { type: 'settings.changed'; keys: string[] }
  | { type: 'catalog.changed' }
  | { type: 'backup.status'; status: 'ok' | 'warning' | 'error' }
  | { type: 'print.status'; printerId: string; status: 'pending' | 'printing' | 'done' | 'failed' | 'uncertain' }
  | { type: 'display.order'; order: OrderDto | null }

export type AtlasEventType = AtlasEvent['type']
