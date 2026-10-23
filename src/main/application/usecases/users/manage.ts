import { z } from 'zod'
import type { Result } from '@shared/result'
import { newId } from '@shared/ids'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isValidPin,
  normalizeUsername
} from '../../../domain/users/credentials'
import { ProfileInputSchema, type ProfileInput } from '../../../domain/users/profile'
import { requirePermission, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { UserEdit, UsersRepo } from '../../../infrastructure/db/repos/users-repo'
import type { Tx, UnitOfWork } from '../../../infrastructure/db/uow'
import { hashSecretAsync } from '../../../infrastructure/security/password'
import { findPinHolders } from '../../../infrastructure/security/pin'
import { AppErrorException } from '../../errors'
import { attempt, attemptSync, invalidInput } from './outcome'

const SaveUserSchema = z.strictObject({
  /** Absent to create a user. */
  id: z.string().min(1).optional(),
  displayName: z.string().trim().min(1).max(60),
  profileId: z.string().min(1),
  /** Absent: `fr` for a new user, unchanged for an existing one. */
  lang: z.enum(['fr', 'ar', 'en']).optional(),
  /** Absent: active for a new user, unchanged for an existing one. */
  active: z.boolean().optional(),
  /** Required to create a user. Absent on an edit: the PIN is kept. */
  pin: z.string().optional(),
  /** Absent: unchanged. `null`: no back office access (the password goes too). */
  username: z.string().nullable().optional(),
  /** Absent: unchanged. A username always has a password. */
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).nullable().optional()
})

export type SaveUserInput = z.input<typeof SaveUserSchema>

export interface ManageUseCases {
  /**
   * Creates or edits a user. Needs `users.manage`. The PIN must be 4 to 6 digits and different from
   * every other user's, deactivated ones included (a deactivated user keeps their PIN reserved, so
   * that reactivating them can never create a duplicate). There is always at least one active user
   * whose profile holds every permission: a save that would leave none is refused with `last_manager`
   * and changes nothing.
   */
  saveUser(session: Session, input: SaveUserInput): Promise<Result<{ id: string }>>
  /** Creates or edits a permission profile. Needs `users.manage`; `last_manager` applies as for users. */
  saveProfile(session: Session, input: ProfileInput): Result<{ id: string }>
}

const firstIssue = (error: z.ZodError): AppErrorException => {
  const issue = error.issues[0]
  return invalidInput((issue?.path ?? []).join('.'), issue?.message)
}

export function createManageUseCases(deps: { uow: UnitOfWork; users: UsersRepo }): ManageUseCases {
  const { uow, users } = deps

  // One save at a time: the PIN is checked against the other users before the transaction (hashing is
  // asynchronous), and two saves of the same PIN must not both pass that check.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  const assertManagerRemains = (): void => {
    if (users.countActiveManagers() === 0) throw new AppErrorException('last_manager')
  }

  async function save(session: Session, raw: SaveUserInput): Promise<{ id: string }> {
    requirePermission(session, 'users.manage')
    const parsed = SaveUserSchema.safeParse(raw)
    if (!parsed.success) throw firstIssue(parsed.error)
    const input = parsed.data

    const existing = input.id === undefined ? undefined : users.getUser(input.id)
    if (input.id !== undefined && !existing) throw invalidInput('id', 'unknown user')
    if (!users.getProfile(input.profileId)) throw invalidInput('profileId', 'unknown profile')

    // Username and password: a username without a password cannot log in, a password without a username is never asked for.
    let username = existing?.username ?? null
    if (input.username !== undefined) {
      username = input.username === null ? null : normalizeUsername(input.username)
      if (input.username !== null && username === null) throw invalidInput('username', 'invalid username')
    }
    let passwordHash = existing?.passwordHash ?? null
    if (username === null) {
      if (typeof input.password === 'string') throw invalidInput('username', 'a password needs a username')
      passwordHash = null
    } else if (typeof input.password === 'string') {
      passwordHash = await hashSecretAsync(input.password)
    } else if (input.password === null || passwordHash === null) {
      throw invalidInput('password', 'a username needs a password')
    }

    let pinHash = existing?.pinHash
    if (input.pin !== undefined) {
      if (!isValidPin(input.pin)) throw new AppErrorException('invalid_pin_format')
      const others = users.listUsers().filter((user) => user.id !== input.id)
      if ((await findPinHolders(input.pin, others)).length > 0) throw new AppErrorException('pin_in_use')
      pinHash = await hashSecretAsync(input.pin)
    }
    if (pinHash === undefined) throw invalidInput('pin', 'a new user needs a PIN')

    const edit: UserEdit = {
      id: input.id ?? newId(),
      displayName: input.displayName,
      pinHash,
      username,
      passwordHash,
      profileId: input.profileId,
      lang: input.lang ?? existing?.lang ?? 'fr',
      active: input.active ?? existing?.active ?? true
    }
    const pinChanged = input.pin !== undefined
    const passwordChanged = typeof input.password === 'string'

    uow.run((tx: Tx) => {
      const owner = username === null ? undefined : users.findByUsername(username)
      if (owner && owner.id !== edit.id) throw new AppErrorException('username_taken')
      if (existing) users.updateUser(tx, edit)
      else users.insertUser(tx, edit)
      // A new PIN or password is a fresh start: it lifts a lock the user may be under.
      if (existing && (pinChanged || passwordChanged)) users.clearFailures(tx, edit.id)
      // Counted after the change, so one check covers deactivating, moving to another profile, anything.
      assertManagerRemains()
      appendEvent(
        tx.db,
        {
          type: 'user.saved',
          entity: 'user',
          entityId: edit.id,
          userId: session.userId,
          data: { created: !existing, pinChanged, passwordChanged, profileId: edit.profileId, active: edit.active }
        },
        tx.clock
      )
    })
    return { id: edit.id }
  }

  function saveProfile(session: Session, raw: ProfileInput): { id: string } {
    requirePermission(session, 'users.manage')
    const parsed = ProfileInputSchema.safeParse(raw)
    if (!parsed.success) throw firstIssue(parsed.error)
    const input = parsed.data
    if (input.id !== undefined && !users.getProfile(input.id)) throw invalidInput('id', 'unknown profile')

    const profile = {
      id: input.id ?? newId(),
      name: input.name,
      permissions: input.permissions,
      maxDiscountBp: input.maxDiscountBp
    }
    uow.run((tx) => {
      if (input.id === undefined) users.insertProfile(tx, profile)
      else users.updateProfile(tx, profile)
      assertManagerRemains()
      appendEvent(
        tx.db,
        {
          type: 'profile.saved',
          entity: 'profile',
          entityId: profile.id,
          userId: session.userId,
          data: { created: input.id === undefined, permissions: profile.permissions, maxDiscountBp: profile.maxDiscountBp }
        },
        tx.clock
      )
    })
    return { id: profile.id }
  }

  return {
    saveUser: (session, input) => serial(() => attempt(() => save(session, input))),
    saveProfile: (session, input) => attemptSync(() => saveProfile(session, input))
  }
}
