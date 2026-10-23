import { describe, expect, it } from 'vitest'
import { CRASH_WINDOW_MS, nextAction } from '../../src/main/supervisor-policy'

const MIN = 60_000
const now = 100 * MIN

describe('supervisor policy', () => {
  it('restarts after one or two crashes', () => {
    expect(nextAction([now], now)).toBe('restart')
    expect(nextAction([now - 2 * MIN, now], now)).toBe('restart')
  })

  it('starts in safe mode after three crashes within five minutes', () => {
    expect(nextAction([now - 4 * MIN, now - 1 * MIN, now], now)).toBe('safe-mode')
    expect(nextAction([now - 30 * MIN, now - 4 * MIN, now - 1 * MIN, now], now)).toBe('safe-mode')
  })

  it('forgets crashes older than five minutes', () => {
    expect(nextAction([now - CRASH_WINDOW_MS, now - 1 * MIN, now], now)).toBe('restart')
    expect(nextAction([now - 20 * MIN, now - 10 * MIN, now], now)).toBe('restart')
  })
})
