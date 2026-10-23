import type { Clock } from '../../ports'

export interface AttemptLimiterOptions {
  /** Failures in a row that start a lock. */
  maxFailures: number
  /** How long a lock lasts. It is also how long a failure is remembered when no lock follows. */
  lockMs: number
}

export interface AttemptLimiter {
  /** ISO instant the key stays locked until, or null when it is not locked. */
  lockedUntil(key: string): string | null
  /** Counts a failure. Returns the lock if this failure started it, or if the key was already locked; null otherwise. */
  fail(key: string): { until: string } | null
  /** Forgets the key (after a success). */
  reset(key: string): void
  size(): number
}

interface Entry {
  failures: number
  lastFailureMs: number
  lockedUntilMs: number
}

const PRUNE_ABOVE = 500

/**
 * In-memory failure counting for the attempts that have no `users` row to carry the count: a back
 * office client typing usernames that do not exist, and the manager-PIN prompt, whose PIN names no
 * one. It restarts with the application, unlike the per-user lock, which is stored.
 */
export function createAttemptLimiter(clock: Clock, { maxFailures, lockMs }: AttemptLimiterOptions): AttemptLimiter {
  const entries = new Map<string, Entry>()

  const isStale = (e: Entry, nowMs: number): boolean =>
    e.lockedUntilMs > nowMs ? false : Math.max(e.lockedUntilMs, e.lastFailureMs + lockMs) <= nowMs

  const prune = (nowMs: number): void => {
    if (entries.size <= PRUNE_ABOVE) return
    for (const [key, entry] of entries) if (isStale(entry, nowMs)) entries.delete(key)
  }

  return {
    lockedUntil(key) {
      const entry = entries.get(key)
      if (!entry) return null
      const nowMs = clock.now().getTime()
      if (entry.lockedUntilMs > nowMs) return new Date(entry.lockedUntilMs).toISOString()
      return null
    },

    fail(key) {
      const nowMs = clock.now().getTime()
      let entry = entries.get(key)
      if (entry && entry.lockedUntilMs > nowMs) return { until: new Date(entry.lockedUntilMs).toISOString() }
      if (!entry || isStale(entry, nowMs)) {
        prune(nowMs)
        entry = { failures: 0, lastFailureMs: nowMs, lockedUntilMs: 0 }
        entries.set(key, entry)
      }
      entry.failures += 1
      entry.lastFailureMs = nowMs
      if (entry.failures < maxFailures) return null
      entry.failures = 0
      entry.lockedUntilMs = nowMs + lockMs
      return { until: new Date(entry.lockedUntilMs).toISOString() }
    },

    reset(key) {
      entries.delete(key)
    },

    size: () => entries.size
  }
}
