/**
 * Failed logins before a lock. Each door has its own counter and its own lock (the `pin_*` columns
 * for the till, `failed_logins` / `locked_until` for the back office password), so locking one never
 * stops the other: a client hammering a manager's web password cannot lock the manager out of the till.
 */
export const MAX_FAILED_LOGINS = 5
/** Till: a short lock, because a cashier with a mistyped PIN is a queue at the counter. */
export const PIN_LOCK_MS = 60_000
/** Back office: a manager is not in a hurry, and the door is reachable from the whole LAN. */
export const PASSWORD_LOCK_MS = 15 * 60_000
/** Technician code: it opens the reconfiguration menu, so a lock is long. Kept in memory, see `verifyTechnician`. */
export const TECHNICIAN_LOCK_MS = 5 * 60_000
/** How long a manager's approval stays usable. */
export const OVERRIDE_TTL_MS = 60_000

/** True while `lockedUntil` (an ISO instant, or null) is still in the future. */
export const isLocked = (lockedUntil: string | null, now: Date): boolean =>
  lockedUntil !== null && Date.parse(lockedUntil) > now.getTime()
