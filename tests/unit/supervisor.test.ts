import { describe, expect, it } from 'vitest'
import {
  CRASH_WINDOW_MS,
  MAX_CRASH_TIMES,
  RESTART_NORMALLY_EXIT_CODE,
  initialState,
  nextAction,
  onChildExit,
  type SupervisorState
} from '../../src/main/supervisor-policy'

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

describe('supervisor exit handling', () => {
  /** Replays exits one second apart from `start`, returning every decision. */
  function replay(codes: (number | null)[], start = now) {
    let state: SupervisorState = initialState()
    return codes.map((code, i) => {
      const next = onChildExit(state, code, start + i * 1000)
      state = next.state
      return { ...next.decision, crashes: state.crashTimes.length }
    })
  }

  it('stops on a clean exit', () => {
    expect(onChildExit(initialState(), 0, now).decision).toEqual({ kind: 'stop' })
  })

  it('counts a signal (code null) as a crash', () => {
    expect(onChildExit(initialState(), null, now).decision).toEqual({ kind: 'launch', safeMode: false, delayMs: 1000 })
  })

  it('goes to safe mode on the third crash, then backs off 1 s, 2 s, 4 s... up to 60 s', () => {
    const decisions = replay([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(decisions.slice(0, 2).map((d) => d.kind === 'launch' && d.safeMode)).toEqual([false, false])
    const delays = decisions.slice(2).map((d) => (d.kind === 'launch' && d.safeMode ? d.delayMs : -1))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
  })

  it('starts normally again on exit code 75, forgetting the crashes', () => {
    const decisions = replay([1, 1, 1, RESTART_NORMALLY_EXIT_CODE, 1])
    expect(decisions[2]).toMatchObject({ kind: 'launch', safeMode: true })
    expect(decisions[3]).toEqual({ kind: 'launch', safeMode: false, delayMs: 0, crashes: 0 })
    expect(decisions[4]).toEqual({ kind: 'launch', safeMode: false, delayMs: 1000, crashes: 1 })
  })

  it('keeps a bounded crash history', () => {
    const decisions = replay(Array.from({ length: 50 }, () => 1))
    expect(Math.max(...decisions.map((d) => d.crashes))).toBe(MAX_CRASH_TIMES)
  })
})
