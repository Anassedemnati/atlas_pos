import { z } from 'zod'
import type { OverrideTokenDto, SessionDto, TillUserDto } from '../dto'
import { def, id, int, localizedName, none, permission } from './define'

/** Staff: PIN login (the session stays in the main process), manager override, technician code. */
export const usersChannels = {
  'users.listTill': def<TillUserDto[]>()(none, 'public'),
  /** Signs the user in on this window. */
  'users.loginPin': def<SessionDto>()(z.strictObject({ userId: id, pin: z.string().max(16) }), 'public'),
  /** Signs out of this window (the technician mode ends too). */
  'users.logout': def<true>()(none, 'public'),
  /** The user signed in on this window, or null. */
  'users.current': def<SessionDto | null>()(none, 'public'),
  /** A manager's PIN approving one action within 60 s; pass its `id` as `overrideTokenId`. */
  'users.authorizeOverride': def<OverrideTokenDto>()(z.strictObject({ pin: z.string().max(16), permission }), 'session'),
  /** Turns the technician mode on for this window. */
  'users.verifyTechnician': def<true>()(z.strictObject({ code: z.string().max(64) }), 'public'),
  'users.saveUser': def<{ id: string }>()(
    z.strictObject({
      id: id.optional(),
      displayName: z.string(),
      profileId: id,
      lang: z.enum(['fr', 'ar', 'en']).optional(),
      active: z.boolean().optional(),
      pin: z.string().max(16).optional(),
      username: z.string().max(200).nullable().optional(),
      password: z.string().max(1000).nullable().optional()
    }),
    'session'
  ),
  'users.saveProfile': def<{ id: string }>()(
    z.strictObject({ id: id.optional(), name: localizedName, permissions: z.array(permission), maxDiscountBp: int }),
    'session'
  )
}
