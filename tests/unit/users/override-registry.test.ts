import { describe, expect, it } from 'vitest'
import { createOverrideRegistry } from '../../../src/main/application/usecases/users/override-registry'
import { mutableClock } from '../../helpers/clock'

describe('override registry', () => {
  const setup = () => {
    const clock = mutableClock('2026-10-22T10:00:00.000Z')
    return { clock, registry: createOverrideRegistry(clock) }
  }

  it('issues a token valid for 60 seconds', () => {
    const { registry } = setup()
    const token = registry.issue('u-amine', 'order.discount.override')
    expect(token).toMatchObject({
      byUserId: 'u-amine',
      permission: 'order.discount.override',
      expiresAt: '2026-10-22T10:01:00.000Z'
    })
    expect(token.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is good for one use only', () => {
    const { registry } = setup()
    const token = registry.issue('u-amine', 'order.discount.override')
    expect(registry.consume(token, 'order.discount.override')).toEqual({
      byUserId: 'u-amine',
      permission: 'order.discount.override'
    })
    expect(registry.consume(token, 'order.discount.override')).toBeNull()
  })

  it('expires after 60 seconds', () => {
    const { clock, registry } = setup()
    const token = registry.issue('u-amine', 'order.discount.override')
    clock.advance(60_000)
    expect(registry.consume(token, 'order.discount.override')).toBeNull()
  })

  it('is still good just before the end', () => {
    const { clock, registry } = setup()
    const token = registry.issue('u-amine', 'order.discount.override')
    clock.advance(59_999)
    expect(registry.consume(token, 'order.discount.override')).toMatchObject({ byUserId: 'u-amine' })
  })

  it('approves the permission it was issued for, and a refused use does not burn it', () => {
    const { registry } = setup()
    const token = registry.issue('u-amine', 'order.void_sent')
    expect(registry.consume(token, 'order.discount.override')).toBeNull()
    expect(registry.consume(token, 'order.void_sent')).toEqual({ byUserId: 'u-amine', permission: 'order.void_sent' })
  })

  it('trusts its own record, not the object it is handed back', () => {
    const { registry } = setup()
    const token = registry.issue('u-sara', 'order.void_sent')
    const forged = { ...token, byUserId: 'u-amine', permission: 'order.discount.override' as const }
    expect(registry.consume(forged, 'order.discount.override')).toBeNull()
    const relabelled = { ...token, byUserId: 'u-amine' }
    expect(registry.consume(relabelled, 'order.void_sent')).toEqual({ byUserId: 'u-sara', permission: 'order.void_sent' })
  })

  it('refuses a token it never issued', () => {
    const { registry } = setup()
    expect(
      registry.consume(
        { id: 'nope', byUserId: 'u-amine', permission: 'order.void_sent', expiresAt: '2099-01-01T00:00:00.000Z' },
        'order.void_sent'
      )
    ).toBeNull()
  })

  it('forgets expired tokens', () => {
    const { clock, registry } = setup()
    for (let i = 0; i < 50; i++) registry.issue('u-amine', 'order.void_sent')
    clock.advance(61_000)
    registry.issue('u-amine', 'order.void_sent')
    expect(registry.size()).toBe(1)
  })

  it('peek tells whether consume would accept the token, without spending it', () => {
    const clock = mutableClock()
    const registry = createOverrideRegistry(clock)
    const token = registry.issue('u-amine', 'order.discount.override')
    expect(registry.peek(token, 'order.discount.override')).toBe(true)
    expect(registry.peek(token, 'order.free_item')).toBe(false)
    expect(registry.peek(token, 'order.discount.override')).toBe(true)
    expect(registry.consume(token, 'order.discount.override')).toMatchObject({ byUserId: 'u-amine' })
    expect(registry.peek(token, 'order.discount.override')).toBe(false)
    const late = registry.issue('u-amine', 'order.discount.override')
    clock.advance(61_000)
    expect(registry.peek(late, 'order.discount.override')).toBe(false)
  })
})
