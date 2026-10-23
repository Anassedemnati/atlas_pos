import type { Clock } from '../../src/main/application/ports'

/** A clock that always returns the same instant (ISO string in, `Date` out). */
export function fixedClock(iso = '2026-10-22T10:00:00.000Z'): Clock {
  return { now: () => new Date(iso) }
}
