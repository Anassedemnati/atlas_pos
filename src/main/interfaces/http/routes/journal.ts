import type { FastifyInstance } from 'fastify'
import { requirePermission } from '../../../domain/users/session'
import { readLogs } from '../../../application/usecases/setup/technician'
import { acting, ok, queryText, route, type Env } from './shared'
import { reportsOf } from './reports'

/** The event log (who did what) and the errors of the application log. Needs `settings.manage`. */
export function registerJournalRoutes(app: FastifyInstance, env: Env): void {
  app.get(
    '/api/journal',
    route(env, (request) => {
      const { services, session } = acting(env, request)
      const query = request.query as Record<string, unknown>
      const limit = queryText(query['limit'])
      const type = queryText(query['type'])
      return reportsOf(services.db).journal(session, {
        ...(type ? { type } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {})
      })
    })
  )

  app.get(
    '/api/journal/errors',
    route(env, (request) => {
      const { session } = acting(env, request)
      requirePermission(session, 'settings.manage')
      const lines = readLogs(env.deps.paths, 500)
        .filter((line) => line.level === 'warn' || line.level === 'error')
        .map(({ data, ...line }) => {
          const { stack: _stack, ...rest } = data
          return { ...line, data: rest }
        })
      return ok(lines.slice(-100).reverse())
    })
  )
}
