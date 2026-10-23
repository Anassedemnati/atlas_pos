import type { FastifyInstance } from 'fastify'
import { createReportsService, exportReport, reportFileName, type ReportFormat, type ReportsService } from '../../../application/usecases/reports'
import { buildSalesReport, REPORT_GROUPS, type ReportGroup } from '../../../application/usecases/reports/sales'
import { requirePermission } from '../../../domain/users/session'
import { AppErrorException } from '../../../application/errors'
import { localDate } from '../../../application/usecases/reports/period'
import type { Database } from '../../../infrastructure/db/connection'
import { acting, queryText, route, sendResult, type Env } from './shared'

const services = new WeakMap<Database, ReportsService>()

/** The read use cases of a database, built once per database (a restore opens a new one). */
export function reportsOf(db: Database): ReportsService {
  let found = services.get(db)
  if (!found) {
    found = createReportsService({ db })
    services.set(db, found)
  }
  return found
}

interface Query {
  from: string
  to: string
  group: string
}

/** The period of the query; the default is the current month so far. */
function periodOf(raw: unknown, clock: () => Date): Query {
  const query = (raw ?? {}) as Record<string, unknown>
  const today = localDate(clock())
  return {
    from: queryText(query['from']) ?? `${today.slice(0, 8)}01`,
    to: queryText(query['to']) ?? today,
    group: queryText(query['group']) ?? 'day'
  }
}

/** Takings over a period by day, product, category, user or payment method; the Z history; Excel / CSV. */
export function registerReportsRoutes(app: FastifyInstance, env: Env): void {
  const now = (): Date => (env.deps.clock ?? { now: () => new Date() }).now()

  app.get(
    '/api/reports',
    route(env, (request) => {
      const { services: s, session } = acting(env, request)
      return reportsOf(s.db).sales(session, periodOf(request.query, now))
    })
  )

  app.get(
    '/api/reports/z',
    route(env, (request) => {
      const { services: s, session } = acting(env, request)
      const { from, to } = periodOf(request.query, now)
      return reportsOf(s.db).zList(session, { from, to })
    })
  )

  app.get('/api/reports/export', async (request, reply) => {
    try {
      const { services: s, session } = acting(env, request)
      requirePermission(session, 'report.x')
      const query = periodOf(request.query, now)
      if (!(REPORT_GROUPS as readonly string[]).includes(query.group)) throw new AppErrorException('invalid_input', { field: 'group' })
      const format = (queryText((request.query as Record<string, unknown>)['format']) ?? 'xlsx') as ReportFormat
      if (format !== 'xlsx' && format !== 'csv') throw new AppErrorException('invalid_input', { field: 'format' })
      const report = buildSalesReport(s.db, { from: query.from, to: query.to, group: query.group as ReportGroup })
      const type = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      return reply
        .header('content-type', type)
        .header('content-disposition', `attachment; filename="${reportFileName(report, format)}"`)
        .send(exportReport(report, format))
    } catch (error) {
      if (error instanceof AppErrorException) return sendResult(reply, { ok: false, error })
      throw error
    }
  })
}
