/**
 * Failed logins before a lock. One counter per user serves both doors (till PIN and back office
 * password): the lock lasts as long as the door that tripped it.
 */
export const MAX_FAILED_LOGINS = 5
/** Till: a short lock, because a cashier with a mistyped PIN is a queue at the counter. */
export const PIN_LOCK_MS = 60_000
/** Back office: a manager is not in a hurry, and the door is reachable from the whole LAN. */
export const PASSWORD_LOCK_MS = 15 * 60_000
/** How long a manager's approval stays usable. */
export const OVERRIDE_TTL_MS = 60_000

/** True while `lockedUntil` (an ISO instant, or null) is still in the future. */
export const isLocked = (lockedUntil: string | null, now: Date): boolean =>
  lockedUntil !== null && Date.parse(lockedUntil) > now.getTime()
