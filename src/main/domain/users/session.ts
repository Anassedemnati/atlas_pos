import type { Lang } from '@shared/names'
import type { Permission } from '@shared/permissions'
import { AppErrorException } from '../../application/errors'

/**
 * Who is acting, built once at login (till PIN or back office password) from the user and the
 * permissions of its profile. Use cases and the IPC/HTTP layers receive it; none of them reads the
 * database to know what the user may do.
 */
export interface Session {
  userId: string
  displayName: string
  lang: Lang
  permissions: Set<Permission>
  /** Largest discount the user may give without a manager's approval, in basis points (1000 = 10 %). */
  maxDiscountBp: number
  isTechnician: boolean
}

/**
 * A manager's approval of one action, obtained with `authorizeOverride(pin, permission)`. Valid 60 s,
 * for one use: a use case hands it to `consumeOverride`, which checks it against what was issued
 * (`id` is the lookup key; the other fields are for display).
 */
export interface OverrideToken {
  id: string
  /** The manager who approved. */
  byUserId: string
  permission: Permission
  /** ISO instant. */
  expiresAt: string
}

export const hasPermission = (session: Session, permission: Permission): boolean =>
  session.permissions.has(permission)

/** Throws `AppError('forbidden')` (`params.permission` = the missing one) unless the session holds `permission`. */
export function requirePermission(session: Session, permission: Permission): void {
  if (!hasPermission(session, permission)) throw new AppErrorException('forbidden', { permission })
}

/** True when the session holds every one of `permissions` (an empty list is trivially held). */
export const holdsAll = (session: Session, permissions: readonly Permission[]): boolean =>
  permissions.every((permission) => session.permissions.has(permission))

/**
 * Could this session hand out the profile `profile`? It must hold every permission of it, and its
 * discount limit must not exceed the session's own, unless the session may approve discounts over any
 * limit (`order.discount.override`, a full manager). Used by `saveProfile` and `saveUser`, so that
 * managing users never raises anyone, the session included, above what the session itself holds.
 */
export const holdsProfile = (
  session: Session,
  profile: { permissions: readonly Permission[]; maxDiscountBp: number }
): boolean =>
  holdsAll(session, profile.permissions) &&
  (profile.maxDiscountBp <= session.maxDiscountBp || hasPermission(session, 'order.discount.override'))
