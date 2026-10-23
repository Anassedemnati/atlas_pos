import type { Permission } from '@shared/permissions'
import type { Result } from '@shared/result'
import { initialsOf, isValidPin, normalizeUsername } from '../../../domain/users/credentials'
import { MAX_FAILED_LOGINS, PASSWORD_LOCK_MS, PIN_LOCK_MS, isLocked } from '../../../domain/users/lockout'
import { hasPermission, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { UserRecord, UsersRepo } from '../../../infrastructure/db/repos/users-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { verifyAgainstDecoy, verifySecretAsync } from '../../../infrastructure/security/password'
import type { Clock } from '../../ports'
import { createAttemptLimiter } from './attempt-limiter'
import { refuse } from './outcome'

export interface TillUser {
  id: string
  displayName: string
  initials: string
}

export interface LoginUseCases {
  /** The active users, for the PIN tiles, in creation order. No secret leaves the main process. */
  listTillUsers(): TillUser[]
  /**
   * 4 to 6 digits. The 5th failure locks the user for 60 s; the lock is stored, so it survives a
   * restart. The count is shared with `loginPassword`: one counter per user, and a lock stops both doors.
   */
  loginPin(userId: string, pin: string): Promise<Result<Session>>
  /**
   * Needs `backoffice.login`. The 5th failure locks the user for 15 min. `clientKey` identifies the
   * browser (its IP): it goes to the audit log, and a client that types 5 unknown usernames is blocked
   * for 15 min (there is no user row to lock).
   */
  loginPassword(username: string, password: string, clientKey: string): Promise<Result<Session>>
}

interface Door {
  channel: 'pin' | 'password'
  lockMs: number
  /** Data added to every event of this attempt (the client of a back office login). */
  extra: Record<string, unknown>
  /** The user must hold it, once the secret is right. */
  requires?: Permission
}

export function createLoginUseCases(deps: { uow: UnitOfWork; clock: Clock; users: UsersRepo }): LoginUseCases {
  const { uow, clock, users } = deps
  const clientLimiter = createAttemptLimiter(clock, { maxFailures: MAX_FAILED_LOGINS, lockMs: PASSWORD_LOCK_MS })

  const sessionFor = (user: UserRecord): Session => {
    const profile = users.getProfile(user.profileId)
    return {
      userId: user.id,
      displayName: user.displayName,
      lang: user.lang,
      permissions: new Set(profile?.permissions ?? []),
      maxDiscountBp: profile?.maxDiscountBp ?? 0,
      isTechnician: false
    }
  }

  const locked = (until: string): ReturnType<typeof refuse> => refuse('locked', { until })

  /**
   * A user that cannot log in with this door (unknown, deactivated, no password): the same answer as
   * a wrong secret, after the same time. With a `clientKey` the refusal is also counted against that
   * client, since there is no user row to carry the count.
   */
  async function rejectUnknown(
    door: Door,
    secret: string,
    entityId: string | undefined,
    clientKey?: string
  ): Promise<Result<Session>> {
    await verifyAgainstDecoy(secret)
    // Blocked meanwhile (parallel attempts): no count, no event.
    const priorLock = clientKey === undefined ? null : clientLimiter.lockedUntil(clientKey)
    if (priorLock) return locked(priorLock)
    const lock = clientKey === undefined ? null : clientLimiter.fail(clientKey)
    uow.run((tx) => {
      appendEvent(
        tx.db,
        {
          type: 'user.login_failed',
          entity: 'user',
          ...(entityId === undefined ? {} : { entityId }),
          data: { channel: door.channel, reason: 'unknown_user', ...door.extra }
        },
        tx.clock
      )
      if (lock) {
        appendEvent(
          tx.db,
          { type: 'client.blocked', entity: 'client', entityId: clientKey!, data: { until: lock.until } },
          tx.clock
        )
      }
    })
    return lock ? locked(lock.until) : refuse('invalid_credentials')
  }

  /**
   * Checks the secret of a user the door can serve. The hash runs on the thread pool, outside any
   * transaction (a transaction is synchronous). The outcome is then written in one transaction that
   * re-reads the user: a burst of parallel guesses all pass the first lock check, but only the first
   * 5 failures are counted, and the others find the lock the 5th one set. A refusal is returned,
   * never thrown, from inside the transaction, so the failure count and the audit row are kept.
   */
  async function authenticate(user: UserRecord, secret: string, hash: string, door: Door): Promise<Result<Session>> {
    if (isLocked(user.lockedUntil, clock.now())) return locked(user.lockedUntil!)
    const secretIsRight = await verifySecretAsync(secret, hash)

    return uow.run((tx): Result<Session> => {
      const fresh = users.getUser(user.id)
      if (!fresh || !fresh.active) return refuse('invalid_credentials')
      const now = tx.clock.now()
      // Locked meanwhile: no count, no event (an append-only log must not grow with every attempt of a hammering client).
      if (isLocked(fresh.lockedUntil, now)) return locked(fresh.lockedUntil!)

      if (!secretIsRight) {
        appendEvent(
          tx.db,
          {
            type: 'user.login_failed',
            entity: 'user',
            entityId: fresh.id,
            userId: fresh.id,
            data: { channel: door.channel, reason: 'bad_secret', ...door.extra }
          },
          tx.clock
        )
        if (users.recordFailure(tx, fresh.id) < MAX_FAILED_LOGINS) return refuse('invalid_credentials')
        const until = new Date(now.getTime() + door.lockMs).toISOString()
        users.lock(tx, fresh.id, until)
        appendEvent(
          tx.db,
          { type: 'user.locked', entity: 'user', entityId: fresh.id, userId: fresh.id, data: { channel: door.channel, until } },
          tx.clock
        )
        return locked(until)
      }

      const session = sessionFor(fresh)
      if (door.requires && !hasPermission(session, door.requires)) {
        // Right credentials, wrong door: not a guess, so it is not counted.
        appendEvent(
          tx.db,
          {
            type: 'user.login_failed',
            entity: 'user',
            entityId: fresh.id,
            userId: fresh.id,
            data: { channel: door.channel, reason: 'forbidden', ...door.extra }
          },
          tx.clock
        )
        return refuse('forbidden', { permission: door.requires })
      }
      if (fresh.failedLogins > 0 || fresh.lockedUntil !== null) users.clearFailures(tx, fresh.id)
      appendEvent(
        tx.db,
        { type: 'user.login', entity: 'user', entityId: fresh.id, userId: fresh.id, data: { channel: door.channel, ...door.extra } },
        tx.clock
      )
      return { ok: true, value: session }
    })
  }

  return {
    listTillUsers: () =>
      users
        .listUsers()
        .filter((user) => user.active)
        .map((user) => ({ id: user.id, displayName: user.displayName, initials: initialsOf(user.displayName) })),

    async loginPin(userId, pin) {
      // A PIN the keypad cannot produce is a mistake, not a guess: it is neither counted nor logged.
      if (!isValidPin(pin)) return refuse('invalid_pin_format')
      const door: Door = { channel: 'pin', lockMs: PIN_LOCK_MS, extra: {} }
      const user = users.getUser(userId)
      // The id comes from the renderer: it goes to the audit log, so its size is bounded.
      if (!user || !user.active) return rejectUnknown(door, pin, userId.slice(0, 64))
      return authenticate(user, pin, user.pinHash, door)
    },

    async loginPassword(username, password, clientKey) {
      const blocked = clientLimiter.lockedUntil(clientKey)
      if (blocked) return locked(blocked)
      const door: Door = {
        channel: 'password',
        lockMs: PASSWORD_LOCK_MS,
        extra: { clientKey },
        requires: 'backoffice.login'
      }
      const name = normalizeUsername(username)
      const user = name === null ? undefined : users.findByUsername(name)
      // The typed username is not logged: people type their password in that field.
      if (!user || !user.active || user.passwordHash === null) {
        return rejectUnknown(door, password, undefined, clientKey)
      }
      return authenticate(user, password, user.passwordHash, door)
    }
  }
}
