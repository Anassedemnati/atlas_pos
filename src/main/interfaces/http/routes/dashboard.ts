import type { BackupStatusDto, DayDto, PrinterDto, PrintJobDto, ZData } from '@shared/dto'
import type { FastifyInstance } from 'fastify'
import { call, ok, route, type Env } from './shared'

export interface DashboardDto {
  /** The open business day, null between a Z and the next sale. */
  day: DayDto | null
  /** The day so far (the X report); null with no open day or without the `report.x` permission. */
  today: ZData | null
  backup: BackupStatusDto | null
  printers: PrinterDto[]
  /** Print jobs that failed or whose outcome is uncertain. */
  jobs: PrintJobDto[]
  version: string
}

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
