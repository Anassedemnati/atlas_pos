import type { Permission } from '@shared/permissions'
import type { Result } from '@shared/result'
import {
  MAX_CLIENT_KEY_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  initialsOf,
  isValidPin,
  normalizeUsername
} from '../../../domain/users/credentials'
import { MAX_FAILED_LOGINS, PASSWORD_LOCK_MS, PIN_LOCK_MS, isLocked } from '../../../domain/users/lockout'
import { hasPermission, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { LoginDoor, UserRecord, UsersRepo } from '../../../infrastructure/db/repos/users-repo'
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
   * 4 to 6 digits. The 5th failure locks the till door of that user for 60 s; the lock is stored
   * (`users.pin_locked_until`), so it survives a restart. It has its own counter: a lock on the back
   * office door (`loginPassword`) does not stop the till, and the other way round.
   */
  loginPin(userId: string, pin: string): Promise<Result<Session>>
  /**
   * Needs `backoffice.login`. The 5th failure locks the back office door of that user for 15 min
   * (`users.failed_logins` / `locked_until`). `clientKey` identifies the browser (its IP; cut at 128
   * characters): it goes to the audit log, and a client that types 5 unknown usernames is blocked for
   * 15 min (there is no user row to lock). A username over 64 characters or a password over 256 is
   * answered like an unknown user, without being hashed.
   */
  loginPassword(username: string, password: string, clientKey: string): Promise<Result<Session>>
}

interface Door {
  channel: LoginDoor
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
    const lockedUntil = user.locks[door.channel].lockedUntil
    if (isLocked(lockedUntil, clock.now())) return locked(lockedUntil!)
    const secretIsRight = await verifySecretAsync(secret, hash)

    return uow.run((tx): Result<Session> => {
      const fresh = users.getUser(user.id)
      if (!fresh || !fresh.active) return refuse('invalid_credentials')
      // The secret was checked against `hash`. If an edit replaced it while the hash was running, that
      // answer is about a secret that no longer exists: refuse, count nothing.
      if ((door.channel === 'pin' ? fresh.pinHash : fresh.passwordHash) !== hash) return refuse('invalid_credentials')
      const now = tx.clock.now()
      const lock = fresh.locks[door.channel]
      // Locked meanwhile: no count, no event (an append-only log must not grow with every attempt of a hammering client).
      if (isLocked(lock.lockedUntil, now)) return locked(lock.lockedUntil!)

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
        if (users.recordFailure(tx, fresh.id, door.channel) < MAX_FAILED_LOGINS) return refuse('invalid_credentials')
        const until = new Date(now.getTime() + door.lockMs).toISOString()
        users.lock(tx, fresh.id, door.channel, until)
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
      if (lock.failedLogins > 0 || lock.lockedUntil !== null) users.clearFailures(tx, fresh.id, door.channel)
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

    async loginPassword(username, password, rawClientKey) {
      const clientKey = rawClientKey.slice(0, MAX_CLIENT_KEY_LENGTH)
      const blocked = clientLimiter.lockedUntil(clientKey)
      if (blocked) return locked(blocked)
      const door: Door = {
        channel: 'password',
        lockMs: PASSWORD_LOCK_MS,
        extra: { clientKey },
        requires: 'backoffice.login'
      }
      // Over the caps: nothing legitimate, and not worth a hash. Answered like an unknown user.
      if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return rejectUnknown(door, '', undefined, clientKey)
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
