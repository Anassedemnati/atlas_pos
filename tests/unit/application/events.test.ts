import { describe, expect, it } from 'vitest'
import { createEventBus, type DomainEvent } from '../../../src/main/application/events'

describe('createEventBus', () => {
  it('delivers an event to the subscribers of its type only', () => {
    const bus = createEventBus()
    const orders: DomainEvent[] = []
    const tickets: DomainEvent[] = []
    bus.subscribe('order.changed', (e) => orders.push(e))
    bus.subscribe('ticket.closed', (e) => tickets.push(e))
    bus.publish({ type: 'order.changed', orderId: 'o1' })
    expect(orders).toEqual([{ type: 'order.changed', orderId: 'o1' }])
    expect(tickets).toEqual([])
  })

  it('hands a subscriber the event narrowed to its type', () => {
    const bus = createEventBus()
    const sent: string[] = []
    bus.subscribe('order.sent', (e) => sent.push(e.orderId, ...e.lineIds))
    bus.publish({ type: 'order.sent', orderId: 'o1', lineIds: ['l1', 'l2'] })
    expect(sent).toEqual(['o1', 'l1', 'l2'])
  })

  it('delivers to every subscriber, in subscription order', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('catalog.changed', () => calls.push('first'))
    bus.subscribe('catalog.changed', () => calls.push('second'))
    bus.publish({ type: 'catalog.changed' })
    expect(calls).toEqual(['first', 'second'])
  })

  it('stops delivering after unsubscribe, and only for that subscription', () => {
    const bus = createEventBus()
    const handler = (): void => {
      calls.push('h')
    }
    const calls: string[] = []
    const off = bus.subscribe('catalog.changed', handler)
    bus.subscribe('catalog.changed', handler) // same function, separate subscription
    off()
    bus.publish({ type: 'catalog.changed' })
    expect(calls).toEqual(['h'])
  })

  it('publishing a type nobody listens to does nothing', () => {
    expect(() => createEventBus().publish({ type: 'catalog.changed' })).not.toThrow()
  })

  it('isolates a throwing subscriber: the others still run and publish does not throw', () => {
    const errors: { error: unknown; event: DomainEvent }[] = []
    const bus = createEventBus((error, event) => errors.push({ error, event }))
    const calls: string[] = []
    bus.subscribe('catalog.changed', () => {
      throw new Error('bug')
    })
    bus.subscribe('catalog.changed', () => calls.push('after'))
    expect(() => bus.publish({ type: 'catalog.changed' })).not.toThrow()
    expect(calls).toEqual(['after'])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.event).toEqual({ type: 'catalog.changed' })
  })

  it('a subscription made while publishing only sees later events', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('catalog.changed', () => {
      calls.push('outer')
      bus.subscribe('catalog.changed', () => calls.push('inner'))
    })
    bus.publish({ type: 'catalog.changed' })
    expect(calls).toEqual(['outer'])
  })
})
