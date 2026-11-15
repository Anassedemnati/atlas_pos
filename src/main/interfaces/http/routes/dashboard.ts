import type { DashboardDto } from '@shared/dto/backoffice'
import type { FastifyInstance } from 'fastify'
import { call, ok, route, type Env } from './shared'

/** Today's takings, the backup health and the printers: the first screen of the back office. */
export function registerDashboardRoutes(app: FastifyInstance, env: Env): void {
  app.get(
    '/api/dashboard',
    route(env, async (request) => {
      const day = await call(env, request, 'days.current', {})
      // The X report needs `report.x`; a user without it simply gets no figures.
      const today = day.ok && day.value ? await call(env, request, 'days.xReport', {}) : null
      const [backup, printers, jobs] = await Promise.all([
        call(env, request, 'backup.status', {}),
        call(env, request, 'printing.printers', {}),
        call(env, request, 'printing.jobs', {})
      ])
      return ok<DashboardDto>({
        day: day.ok ? day.value : null,
        today: today?.ok ? today.value : null,
        backup: backup.ok ? backup.value : null,
        printers: printers.ok ? printers.value : [],
        jobs: jobs.ok ? jobs.value : [],
        version: env.deps.appVersion ?? ''
      })
    })
  )
}
