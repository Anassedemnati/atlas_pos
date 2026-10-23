import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { toSessionDto } from '../../ipc/session-store'
import { refuse } from '../../../application/usecases/users/outcome'
import { SESSION_COOKIE, SESSION_TTL_MS } from '../auth'
import { clientKey } from '../guard'
import { acting, ok, route, sendResult, type Env } from './shared'

const LoginBody = z.strictObject({ username: z.string().max(200), password: z.string().max(1000) })

/** The sign-in: the only route without a session (and without a CSRF token: there is none to hold yet). */
export function registerPublicAuthRoutes(app: FastifyInstance, env: Env): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = LoginBody.safeParse(request.body)
    if (!body.success) return sendResult(reply, refuse('invalid_input', { field: body.error.issues[0]?.path.join('.') ?? '' }))
    const services = env.deps.runtime.services()
    if (!services) return sendResult(reply, refuse('app_not_ready'))
    // The 5th wrong password locks the user for 15 minutes; 5 unknown usernames block this client for as long.
    const result = await services.users.loginPassword(body.data.username, body.data.password, clientKey(request.ip))
    if (!result.ok) return sendResult(reply, result)
    const session = env.sessions.create(result.value.userId)
    env.ipcSessions.signIn(session.windowId, result.value.userId)
    void reply.setCookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000
    })
    return sendResult(reply, ok({ csrfToken: session.csrfToken, user: toSessionDto(result.value) }))
  })
}

/** Who is signed in, and the sign-out. */
export function registerAuthRoutes(app: FastifyInstance, env: Env): void {
  app.get(
    '/api/auth/me',
    route(env, (request) => {
      const { session } = acting(env, request)
      return ok({ csrfToken: request.bo.csrfToken, user: toSessionDto(session) })
    })
  )
  app.post('/api/auth/logout', async (request, reply) => {
    env.sessions.destroy(request.bo.id)
    void reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return sendResult(reply, ok(true as const))
  })
}
