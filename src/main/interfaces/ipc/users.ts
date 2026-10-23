import type { usersChannels } from '@shared/ipc/users'
import { ok, type Handlers } from './context'
import { toSessionDto } from './session-store'

/** PIN login on this window, sign out, manager override, technician code, user and profile edits. */
export const usersHandlers: Handlers<keyof typeof usersChannels> = {
  'users.listTill': (_input, ctx) => ok(ctx.services().users.listTillUsers()),
  'users.loginPin': async ({ userId, pin }, ctx) => {
    const services = ctx.services()
    const result = await services.users.loginPin(userId, pin)
    if (!result.ok) return result
    // A new user on this window: the technician mode of the previous one ends.
    ctx.sessions.signOut(ctx.windowId)
    ctx.sessions.signIn(ctx.windowId, result.value.userId)
    const session = ctx.sessions.session(ctx.windowId, services.usersRepo)
    return session ? ok(toSessionDto(session)) : { ok: false, error: { code: 'not_signed_in', messageKey: 'errors.not_signed_in' } }
  },
  'users.logout': (_input, ctx) => {
    ctx.sessions.signOut(ctx.windowId)
    return ok(true as const)
  },
  'users.current': (_input, ctx) => {
    const session = ctx.optionalSession()
    return ok(session ? toSessionDto(session) : null)
  },
  'users.authorizeOverride': async ({ pin, permission }, ctx) => {
    const result = await ctx.services().users.authorizeOverride(pin, permission)
    if (!result.ok) return result
    const { id, expiresAt } = result.value
    return ok({ id, permission: result.value.permission, expiresAt })
  },
  'users.verifyTechnician': async ({ code }, ctx) => {
    const result = await ctx.services().users.verifyTechnician(code)
    if (result.ok) ctx.sessions.setTechnician(ctx.windowId)
    return result
  },
  'users.saveUser': (input, ctx) => ctx.services().users.saveUser(ctx.session(), input),
  'users.saveProfile': (input, ctx) => ctx.services().users.saveProfile(ctx.session(), input)
}
