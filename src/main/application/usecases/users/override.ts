import type { Permission } from '@shared/permissions'
import type { Result } from '@shared/result'
import { isValidPin } from '../../../domain/users/credentials'
import { MAX_FAILED_LOGINS, PIN_LOCK_MS, isLocked } from '../../../domain/users/lockout'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { UsersRepo } from '../../../infrastructure/db/repos/users-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { findPinHolders } from '../../../infrastructure/security/pin'
import type { Clock } from '../../ports'
import { createAttemptLimiter } from './attempt-limiter'
import { createOverrideRegistry } from './override-registry'
import { refuse } from './outcome'

export interface OverrideUseCases {
  /**
   * A manager types a PIN to approve one action. The user it names must be active, not locked on the
   * till door, and hold `permission`. The token is good for one use within 60 s. Every refusal is
   * `invalid_credentials`, whatever the reason (no such PIN, a PIN of someone who may not approve,
   * a locked or deactivated user): the reason goes to the log only, so the prompt cannot be used to
   * find out whose PIN is whose. Since a PIN here names nobody, a wrong PIN cannot be counted against
   * a user: 5 refusals in a row lock the prompt itself for 60 s (`locked`, in memory), or the prompt
   * would let a cashier guess a manager's PIN.
   */
  authorizeOverride(pin: string, permission: Permission): Promise<Result<OverrideToken>>
  /**
   * Spends a token for `permission`: the approving manager and the permission, or `forbidden`
   * (`params.reason = 'override_invalid'`). The registry forgets the token once spent, so the use
   * case that consumes it must record `overriddenBy: byUserId` with the action it allowed (the ticket
   * line, the discount): `override.granted` in the event log only says that a manager approved something.
   */
  consumeOverride(token: OverrideToken, permission: Permission): Result<{ byUserId: string; permission: Permission }>
  /**
   * May this session give a discount of `discountBp`? It needs `order.discount`, and the discount
   * must not exceed its limit (inclusive) unless `override` (for `order.discount.override`) is
   * given, which is then spent; `overriddenBy` names the approving manager and the caller must record
   * it with the discount. Within the limit, the override is left untouched.
   */
  checkDiscount(
    session: Session,
    discountBp: number,
    override?: OverrideToken
  ): Result<{ overriddenBy?: string }>
}

export function createOverrideUseCases(deps: { uow: UnitOfWork; clock: Clock; users: UsersRepo }): OverrideUseCases {
  const { uow, clock, users } = deps
  const registry = createOverrideRegistry(clock)
  const limiter = createAttemptLimiter(clock, { maxFailures: MAX_FAILED_LOGINS, lockMs: PIN_LOCK_MS })
  const PROMPT = 'override'

  const deny = (permission: Permission, reason: 'bad_pin' | 'forbidden', userId?: string): Result<never> => {
    const lock = limiter.fail(PROMPT)
    uow.run((tx) => {
      appendEvent(
        tx.db,
        {
          type: 'override.denied',
          entity: 'override',
          ...(userId === undefined ? {} : { userId }),
          data: { permission, reason }
        },
        tx.clock
      )
      if (lock) appendEvent(tx.db, { type: 'override.locked', entity: 'override', data: { until: lock.until } }, tx.clock)
    })
    return lock ? refuse('locked', { until: lock.until }) : refuse('invalid_credentials')
  }

  return {
    async authorizeOverride(pin, permission) {
      if (!isValidPin(pin)) return refuse('invalid_pin_format')
      const blocked = limiter.lockedUntil(PROMPT)
      if (blocked) return refuse('locked', { until: blocked })

      // A locked user's PIN is treated as unknown: answering "locked" would confirm that it is right.
      const candidates = users.listUsers().filter((user) => user.active && !isLocked(user.locks.pin.lockedUntil, clock.now()))
      const holderIds = new Set(await findPinHolders(pin, candidates))

      // Everything below is synchronous: nothing can change between these reads and the token.
      // Parallel guesses can pass the first check: only the first 5 refusals are counted, the rest find the lock.
      const lockedMeanwhile = limiter.lockedUntil(PROMPT)
      if (lockedMeanwhile) return refuse('locked', { until: lockedMeanwhile })

      // The user may have been deactivated, locked, or given another PIN while the hashes ran: the PIN
      // was checked against `candidate.pinHash`, so only a user still holding that hash counts.
      const holders = candidates.filter((candidate) => {
        if (!holderIds.has(candidate.id)) return false
        const current = users.getUser(candidate.id)
        return (
          current !== undefined &&
          current.active &&
          current.pinHash === candidate.pinHash &&
          !isLocked(current.locks.pin.lockedUntil, clock.now())
        )
      })
      if (holders.length === 0) return deny(permission, 'bad_pin')
      const approver = holders.find((user) => users.getProfile(user.profileId)?.permissions.includes(permission))
      // A PIN of someone who may not approve gets the same answer as a wrong PIN; only the log tells them apart.
      if (!approver) return deny(permission, 'forbidden', holders[0]!.id)

      limiter.reset(PROMPT)
      uow.run((tx) => {
        appendEvent(
          tx.db,
          { type: 'override.granted', entity: 'override', userId: approver.id, data: { permission } },
          tx.clock
        )
      })
      return { ok: true, value: registry.issue(approver.id, permission) }
    },

    consumeOverride(token, permission) {
      const used = registry.consume(token, permission)
      return used ? { ok: true, value: used } : refuse('forbidden', { permission, reason: 'override_invalid' })
    },

    checkDiscount(session, discountBp, override) {
      if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) {
        return refuse('invalid_input', { field: 'discountBp' })
      }
      if (!hasPermission(session, 'order.discount')) return refuse('forbidden', { permission: 'order.discount' })
      if (discountBp <= session.maxDiscountBp) return { ok: true, value: {} }

      const params = { permission: 'order.discount.override', maxDiscountBp: session.maxDiscountBp }
      if (!override) return refuse('forbidden', params)
      const used = registry.consume(override, 'order.discount.override')
      return used
        ? { ok: true, value: { overriddenBy: used.byUserId } }
        : refuse('forbidden', { ...params, reason: 'override_invalid' })
    }
  }
}
