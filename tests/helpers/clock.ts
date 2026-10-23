import type { Clock } from '../../src/main/application/ports'

/** A clock that always returns the same instant (ISO string in, `Date` out). */
export function fixedClock(iso = '2026-10-22T10:00:00.000Z'): Clock {
  return { now: () => new Date(iso) }
}

export interface MutableClock extends Clock {
  /** Moves the clock forward (or back, with a negative number) by `ms` milliseconds. */
  advance(ms: number): void
}

/** A clock that stands still until the test moves it with `advance`. */
export function mutableClock(iso = '2026-10-22T10:00:00.000Z'): MutableClock {
  let ms = new Date(iso).getTime()
  return {
    now: () => new Date(ms),
    advance(by) {
      ms += by
    }
  }
}
