/** Crashes counted together: 3 within this window start the app in safe mode. */
export const CRASH_WINDOW_MS = 5 * 60_000
export const SAFE_MODE_CRASHES = 3
/** Wait before restarting a crashed app. */
export const RESTART_DELAY_MS = 1000

export type SupervisorAction = 'restart' | 'safe-mode'

/**
 * What the watchdog does after a crash. `crashTimes` are the crash instants (ms) so far, the one that just
 * happened included: 3 or more within the last 5 minutes → `safe-mode`, else `restart`.
 */
export function nextAction(crashTimes: readonly number[], now: number): SupervisorAction {
  const recent = crashTimes.filter((at) => at <= now && now - at < CRASH_WINDOW_MS)
  return recent.length >= SAFE_MODE_CRASHES ? 'safe-mode' : 'restart'
}
