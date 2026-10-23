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

  it('delivers to every subscriber, in subscription order', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('x', () => calls.push('first'))
    bus.subscribe('x', () => calls.push('second'))
    bus.publish({ type: 'x' })
    expect(calls).toEqual(['first', 'second'])
  })

  it('stops delivering after unsubscribe, and only for that subscription', () => {
    const bus = createEventBus()
    const handler = (): void => {
      calls.push('h')
    }
    const calls: string[] = []
    const off = bus.subscribe('x', handler)
    bus.subscribe('x', handler) // same function, separate subscription
    off()
    bus.publish({ type: 'x' })
    expect(calls).toEqual(['h'])
  })

  it('publishing a type nobody listens to does nothing', () => {
    expect(() => createEventBus().publish({ type: 'nobody' })).not.toThrow()
  })

  it('isolates a throwing subscriber: the others still run and publish does not throw', () => {
    const errors: { error: unknown; event: DomainEvent }[] = []
    const bus = createEventBus((error, event) => errors.push({ error, event }))
    const calls: string[] = []
    bus.subscribe('x', () => {
      throw new Error('bug')
    })
    bus.subscribe('x', () => calls.push('after'))
    expect(() => bus.publish({ type: 'x' })).not.toThrow()
    expect(calls).toEqual(['after'])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.event).toEqual({ type: 'x' })
  })

  it('a subscription made while publishing only sees later events', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('x', () => {
      calls.push('outer')
      bus.subscribe('x', () => calls.push('inner'))
    })
    bus.publish({ type: 'x' })
    expect(calls).toEqual(['outer'])
  })
})
