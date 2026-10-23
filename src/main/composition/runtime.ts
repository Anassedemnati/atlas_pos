import type { Result } from '@shared/result'
import { startupCheck, type StartupReport } from '../application/usecases/startup/startup-check'
import { refuse } from '../application/usecases/users/outcome'
import { restoreBackup } from '../infrastructure/backup/restore'
import { describeError } from '../logger'
import { opensDatabase, routeFor } from '../lifecycle/routing'
import { openServices, type Services, type ServicesDeps } from './services'

export interface RuntimeDeps extends ServicesDeps {
  /** `acquireRunningLock(paths).wasUnclean`. */
  unclean: boolean
  /** Started by the watchdog after repeated crashes: nothing is printed until a person decides. */
  safeMode: boolean
}

export interface RuntimeStatus {
  report: StartupReport | null
  startupError: string | null
  route: string
  safeMode: boolean
  ready: boolean
}

/**
 * The application's state across its life: the start-up decision, the services of the open database
 * (none while the setup, a corrupt or a newer database is pending), and their replacement after a restore.
 */
export interface Runtime {
  status(): RuntimeStatus
  /** The use cases, or null when no database is open. */
  services(): Services | null
  /**
   * The start-up check (it opens the database read-only itself), then, for `ok` and `recovered` only,
   * the database opened for writing, migrated, and the services built. Never throws: a failure is
   * logged and routes to the recovery screen.
   */
  boot(): void
  /** Starts the print queue, the backup engine and the USB poll. Call it once the till window exists. */
  startBackground(): void
  /**
   * Replaces the database with a backup. The background work is stopped first; a backup that fails its
   * checks leaves the running services as they were. Once the database was closed, the whole graph is
   * rebuilt (on the restored database, or on the previous one that a failed restore put back).
   */
  restore(file: string): Promise<Result<{ route: string }>>
  /** Stops the background work and closes the database. */
  shutdown(): Promise<void>
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { paths, clock, log, safeMode } = deps
  let report: StartupReport | null = null
  let startupError: string | null = null
  let current: Services | null = null
  let started = false
  let restoring = false

  const status = (): RuntimeStatus => ({
    report,
    startupError,
    route: startupError !== null ? routeFor(null, { safeMode }) : routeFor(report?.state ?? null, { safeMode }),
    safeMode,
    ready: current !== null
  })

  /** Builds the services when the report allows it; a failure becomes `startupError`. */
  const open = (): void => {
    if (!report || !opensDatabase(report.state)) return
    try {
      current = openServices(deps)
    } catch (error) {
      log.error('startup.open_failed', describeError(error))
      startupError = error instanceof Error ? error.message : String(error)
    }
  }

  const startCurrent = (): void => {
    if (started && current) current.start({ printing: !safeMode })
  }

  return {
    status,
    services: () => current,

    boot() {
      try {
        report = startupCheck({ paths, clock, unclean: deps.unclean, log: log.info })
        log.info('startup.report', { state: report.state, unclean: report.unclean, restoredOrders: report.restoredOrders.length })
      } catch (error) {
        log.error('startup.check_failed', describeError(error))
        startupError = error instanceof Error ? error.message : String(error)
        return
      }
      open()
    },

    startBackground() {
      started = true
      startCurrent()
    },

    async restore(file) {
      if (restoring) return refuse('restore_in_progress')
      restoring = true
      try {
        const before = current
        if (before) await before.stop()
        let closed = false
        const result = await restoreBackup({ file }, paths, {
          clock,
          log: log.info,
          ...(before ? { close: () => (before.db.close(), (closed = true)) } : {})
        })
        if (before && !closed) {
          // Refused before anything moved: the same database, the same services.
          startCurrent()
          return result.ok ? { ok: true, value: { route: status().route } } : result
        }
        current = null
        if (result.ok) {
          report = result.value.report
          startupError = null
        }
        open()
        startCurrent()
        log.info('restore.done', { ok: result.ok, file, state: report?.state ?? null })
        return result.ok ? { ok: true, value: { route: status().route } } : result
      } finally {
        restoring = false
      }
    },

    async shutdown() {
      const services = current
      current = null
      if (!services) return
      await services.stop()
      services.db.close()
    }
  }
}
