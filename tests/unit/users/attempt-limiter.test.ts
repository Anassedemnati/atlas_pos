import { describe, expect, it } from 'vitest'
import { createAttemptLimiter } from '../../../src/main/application/usecases/users/attempt-limiter'
import { mutableClock } from '../../helpers/clock'

describe('createAttemptLimiter', () => {
  const setup = () => {
    const clock = mutableClock('2026-10-22T10:00:00.000Z')
    return { clock, limiter: createAttemptLimiter(clock, { maxFailures: 3, lockMs: 60_000 }) }
  }

  it('locks a key on its 3rd failure, until now + lockMs', () => {
    const { limiter } = setup()
    expect(limiter.fail('a')).toBeNull()
    expect(limiter.fail('a')).toBeNull()
    expect(limiter.fail('a')).toEqual({ until: '2026-10-22T10:01:00.000Z' })
    expect(limiter.lockedUntil('a')).toBe('2026-10-22T10:01:00.000Z')
  })

  it('keeps keys apart', () => {
    const { limiter } = setup()
    for (let i = 0; i < 3; i++) limiter.fail('a')
    expect(limiter.lockedUntil('b')).toBeNull()
  })

  it('unlocks when the time is up, and starts counting again from zero', () => {
    const { clock, limiter } = setup()
    for (let i = 0; i < 3; i++) limiter.fail('a')
    clock.advance(60_000)
    expect(limiter.lockedUntil('a')).toBeNull()
    expect(limiter.fail('a')).toBeNull()
    expect(limiter.fail('a')).toBeNull()
    expect(limiter.fail('a')).not.toBeNull()
  })

  it('reset forgets the failures', () => {
    const { limiter } = setup()
    limiter.fail('a')
    limiter.fail('a')
    limiter.reset('a')
    expect(limiter.fail('a')).toBeNull()
    expect(limiter.fail('a')).toBeNull()
  })

  it('does not grow without bound: expired keys are dropped', () => {
    const { clock, limiter } = setup()
    for (let i = 0; i < 2000; i++) limiter.fail(`k${i}`)
    clock.advance(24 * 3600_000)
    limiter.fail('fresh')
    expect(limiter.size()).toBeLessThan(2000)
  })
})
