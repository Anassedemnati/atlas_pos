/** Crashes counted together: 3 within this window start the app in safe mode. */
export const CRASH_WINDOW_MS = 5 * 60_000
export const SAFE_MODE_CRASHES = 3
/** Wait before restarting a crashed app. */
export const RESTART_DELAY_MS = 1000
/** Longest wait between two safe-mode starts (the delay doubles from `RESTART_DELAY_MS`). */
export const MAX_SAFE_MODE_DELAY_MS = 60_000
/** Crash instants kept: enough for the window, bounded however long the supervisor runs. */
export const MAX_CRASH_TIMES = 10
/**
 * The exit code the application uses to ask for a normal start (out of safe mode, after a restore):
 * the supervisor starts it again without `--safe-mode` and forgets the crashes.
 */
export const RESTART_NORMALLY_EXIT_CODE = 75

export type SupervisorAction = 'restart' | 'safe-mode'

/**
 * What the watchdog does after a crash. `crashTimes` are the crash instants (ms) so far, the one that just
 * happened included: 3 or more within the last 5 minutes → `safe-mode`, else `restart`.
 */
export function nextAction(crashTimes: readonly number[], now: number): SupervisorAction {
  const recent = crashTimes.filter((at) => at <= now && now - at < CRASH_WINDOW_MS)
  return recent.length >= SAFE_MODE_CRASHES ? 'safe-mode' : 'restart'
}

export interface SupervisorState {
  crashTimes: number[]
  /** Safe-mode starts in a row that crashed: the delay before the next one doubles with each. */
  safeStreak: number
}

export const initialState = (): SupervisorState => ({ crashTimes: [], safeStreak: 0 })

export type Decision = { kind: 'stop' } | { kind: 'launch'; safeMode: boolean; delayMs: number }

/**
 * The supervisor's answer to the application's exit (`code` null when a signal ended it):
 * - 0: a deliberate quit (quit to desktop, the OS logging out): stop supervising;
 * - `RESTART_NORMALLY_EXIT_CODE`: start again normally at once, crashes forgotten;
 * - anything else is a crash: restart after 1 s, or in safe mode after 3 crashes within 5 minutes,
 *   then waiting 1 s, 2 s, 4 s... up to 60 s between safe-mode starts that crash again.
 */
export function onChildExit(state: SupervisorState, code: number | null, now: number): { decision: Decision; state: SupervisorState } {
  if (code === 0) return { decision: { kind: 'stop' }, state }
  if (code === RESTART_NORMALLY_EXIT_CODE) return { decision: { kind: 'launch', safeMode: false, delayMs: 0 }, state: initialState() }

  const crashTimes = [...state.crashTimes.filter((at) => at <= now && now - at < CRASH_WINDOW_MS), now].slice(-MAX_CRASH_TIMES)
  if (nextAction(crashTimes, now) === 'restart') {
    return { decision: { kind: 'launch', safeMode: false, delayMs: RESTART_DELAY_MS }, state: { crashTimes, safeStreak: 0 } }
  }
  const delayMs = Math.min(RESTART_DELAY_MS * 2 ** state.safeStreak, MAX_SAFE_MODE_DELAY_MS)
  return { decision: { kind: 'launch', safeMode: true, delayMs }, state: { crashTimes, safeStreak: state.safeStreak + 1 } }
}
