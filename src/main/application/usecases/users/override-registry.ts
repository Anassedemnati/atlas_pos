import { randomUUID } from 'node:crypto'
import type { Permission } from '@shared/permissions'
import { OVERRIDE_TTL_MS } from '../../../domain/users/lockout'
import type { OverrideToken } from '../../../domain/users/session'
import type { Clock } from '../../ports'

export interface OverrideRegistry {
  issue(byUserId: string, permission: Permission): OverrideToken
  /**
   * Spends the token: `{ byUserId }` of the manager who approved, or null when it is unknown,
   * already used, expired, or was issued for another permission (that refusal does not spend it).
   * Only `token.id` is read: the registry trusts what it recorded, not the object it is handed.
   */
  consume(token: OverrideToken, permission: Permission): { byUserId: string } | null
  size(): number
}

interface Issued {
  byUserId: string
  permission: Permission
  expiresAtMs: number
}

/** One-time manager approvals, kept in memory: a restart discards them, which only asks the manager again. */
export function createOverrideRegistry(clock: Clock): OverrideRegistry {
  const issued = new Map<string, Issued>()

  const purgeExpired = (nowMs: number): void => {
    for (const [id, entry] of issued) if (entry.expiresAtMs <= nowMs) issued.delete(id)
  }

  return {
    issue(byUserId, permission) {
      const nowMs = clock.now().getTime()
      purgeExpired(nowMs)
      const expiresAtMs = nowMs + OVERRIDE_TTL_MS
      // Not a UUIDv7: its start is a timestamp, and this id is the only thing that makes the token unforgeable.
      const id = randomUUID()
      issued.set(id, { byUserId, permission, expiresAtMs })
      return { id, byUserId, permission, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    consume(token, permission) {
      const entry = issued.get(token.id)
      if (!entry) return null
      if (entry.expiresAtMs <= clock.now().getTime()) {
        issued.delete(token.id)
        return null
      }
      if (entry.permission !== permission) return null
      issued.delete(token.id)
      return { byUserId: entry.byUserId }
    },

    size: () => issued.size
  }
}
