import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { refuse } from '../../application/usecases/users/outcome'
import { describeError } from '../../logger'
import { createSessionStore } from '../ipc/session-store'
import type { IpcDeps, ShellPorts } from '../ipc/context'
import type { SetupService } from '../../application/usecases/setup'
import { CSRF_HEADER, SESSION_COOKIE, createHttpSessions, sameToken } from './auth'
import { registerGuard } from './guard'
import { registerAuthRoutes, registerPublicAuthRoutes } from './routes/auth'
import { registerBackupsRoutes } from './routes/backups'
import { registerCatalogRoutes } from './routes/catalog'
import { registerDashboardRoutes } from './routes/dashboard'
import { registerJournalRoutes } from './routes/journal'
import { registerPrintersRoutes } from './routes/printers'
import { registerReportsRoutes } from './routes/reports'
import { registerSettingsRoutes } from './routes/settings'
import type { Env, HttpDeps } from './routes/shared'
import { registerUsersRoutes } from './routes/users'

export type { HttpDeps } from './routes/shared'

export interface HttpServerOptions {
  /** The port the caller will `listen` on (the server itself is not started here). */
  port: number
  /** The renderer build (`out/renderer`): `backoffice.html` and `assets/`. */
  staticDir: string
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** A sheet (5 MB) or a photo (3 MB) is the largest body; JSON stays under the default 1 MB. */
const UPLOAD_LIMIT = 6 * 1024 * 1024

/** The IPC layer's dependencies, for a back office that is never the setup, never the technician and never at the till. */
function ipcDepsFor(deps: HttpDeps): IpcDeps {
  const shell: Partial<ShellPorts> = {
    appVersion: deps.appVersion ?? '',
    navigateTill: (route) => deps.afterRestore?.(route),
    restartNormally: () => deps.restartNormally?.()
  }
  return {
    paths: deps.paths,
    runtime: deps.runtime,
    // Only the setup channels use it, and they are refused once an installation exists (they are not reachable from here).
    setup: {} as SetupService,
    shell: shell as ShellPorts,
    log: deps.log,
    ...(deps.clock ? { clock: deps.clock } : {})
  }
}

/**
 * The back office: a Fastify server (not listening yet) that serves the single page at `/admin` and the JSON API under
 * `/api`. Every request is first checked against the local network. The API goes through the same validation, permission
 * checks and use cases as the till's IPC; its changes publish the same events, so the till refreshes.
 */
export function createHttpServer(deps: HttpDeps, opts: HttpServerOptions): FastifyInstance {
  const clock = deps.clock ?? { now: () => new Date() }
  const app = Fastify({ bodyLimit: 1024 * 1024, trustProxy: false, logger: false })
  const ipcSessions = createSessionStore()
  const sessions = createHttpSessions(clock)
  sessions.onDrop((windowId) => ipcSessions.forget(windowId))
  const env: Env = { deps, ipc: ipcDepsFor(deps), ipcSessions, sessions }

  registerGuard(app)
  void app.register(fastifyCookie)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (_request, body, done) => done(null, body))

  // The page and its files: no sign-in needed (the page asks for one).
  const page = async (): Promise<string | null> => readFile(join(opts.staticDir, 'backoffice.html'), 'utf8').catch(() => null)
  const serve = async (_request: unknown, reply: import('fastify').FastifyReply) => {
    const html = await page()
    if (html === null) return reply.code(404).type('text/plain').send('Not found')
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html)
  }
  app.get('/', async (_request, reply) => reply.redirect('/admin'))
  app.get('/admin', serve)
  app.get('/admin/', serve)
  // `./assets/...` resolves to `/assets/` from `/admin` and to `/admin/assets/` from `/admin/`.
  void app.register(fastifyStatic, { root: join(opts.staticDir, 'assets'), prefix: '/assets/', decorateReply: false, index: false, dotfiles: 'deny' })
  void app.register(fastifyStatic, { root: join(opts.staticDir, 'assets'), prefix: '/admin/assets/', decorateReply: false, index: false, dotfiles: 'deny' })

  registerPublicAuthRoutes(app, env)

  // Everything else needs a session; a request that changes something also needs its CSRF token.
  void app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', async (request, reply) => {
      const session = sessions.get(request.cookies[SESSION_COOKIE])
      if (!session) return reply.code(401).send(refuse('not_signed_in'))
      const services = deps.runtime.services()
      if (!services) return reply.code(503).send(refuse('app_not_ready'))
      // The rights are read again on every request: a user deactivated or demoted since the login is out.
      const current = ipcSessions.session(session.windowId, services.usersRepo)
      if (!current || !current.permissions.has('backoffice.login')) {
        sessions.destroy(session.id)
        void reply.clearCookie(SESSION_COOKIE, { path: '/' })
        return reply.code(401).send(refuse('not_signed_in'))
      }
      if (!SAFE_METHODS.has(request.method)) {
        const origin = request.headers.origin
        if (origin !== undefined) {
          let host: string | null = null
          try {
            host = new URL(origin).host
          } catch {
            // refused below
          }
          if (host !== request.headers.host) return reply.code(403).send(refuse('forbidden', { reason: 'origin' }))
        }
        if (!sameToken(request.headers[CSRF_HEADER], session.csrfToken)) return reply.code(403).send(refuse('forbidden', { reason: 'csrf' }))
      }
      request.bo = session
    })
    registerAuthRoutes(protectedScope, env)
    registerDashboardRoutes(protectedScope, env)
    registerCatalogRoutes(protectedScope, env)
    registerUsersRoutes(protectedScope, env)
    registerPrintersRoutes(protectedScope, env)
    registerSettingsRoutes(protectedScope, env)
    registerBackupsRoutes(protectedScope, env)
    registerReportsRoutes(protectedScope, env)
    registerJournalRoutes(protectedScope, env)
  })

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send(refuse('not_found'))
    return reply.code(404).type('text/plain').send('Not found')
  })
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) deps.log.error('http.error', { url: request.url.split('?')[0], ...describeError(error) })
    const code = status === 413 ? 'upload_too_large' : status === 415 ? 'unsupported_media' : status < 500 ? 'invalid_input' : 'internal_error'
    return reply.code(status).send(refuse(code))
  })
  return app
}
