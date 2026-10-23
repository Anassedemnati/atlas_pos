import type { AppError, Result } from '@shared/result'
import type { EventBus } from '../../application/ports'
import type { Schedule } from '../backup/engine'
import type { Database } from '../db/connection'
import type { SettingsRepo } from '../db/repos/settings-repo'
import { createDriver, type DriverEnv } from './drivers/factory'
import { createPrintQueue, type PrintLog, type PrintQueue } from './queue'
import { createJobRenderer, docToDriverJob } from './render-job'
import { readPrinter } from './router'
import { testPageDoc } from './templates/test-page'
import type { RenderHtmlToBitmap } from './types'

export interface PrintServiceDeps extends Omit<DriverEnv, 'renderHtml'> {
  db: Database
  settings: Pick<SettingsRepo, 'get'>
  eventBus: EventBus
  /** HTML to bitmap (Electron's offscreen window); the one port every raster receipt goes through. */
  rasterize: RenderHtmlToBitmap
  logo?: () => string | undefined
  log?: PrintLog
  schedule?: Schedule
  /** See `PrintQueueDeps`. */
  backoffMs?: readonly number[]
  pollIntervalMs?: number
}

export interface PrintService {
  /** The persistent queue: pass it to the use cases as their `PrintSpooler`, and `start()` it with the app. */
  queue: PrintQueue
  /**
   * Prints the test page on a printer right now, outside the queue, and reports how it went (a wizard asks
   * "did it print?"). Not persisted: a failed test is shown to the person who asked, not retried.
   */
  testPrint(printerId: string): Promise<Result<null>>
}

const failure = (code: string, params?: Record<string, unknown>): Result<never> => ({
  ok: false,
  error: { code, messageKey: `errors.${code}`, ...(params ? { params } : {}) } satisfies AppError
})

/** The queue wired to its renderer and drivers, with the direct test print. */
export function createPrintService(deps: PrintServiceDeps): PrintService {
  const { db, clock } = deps
  const env: DriverEnv = { ...deps, renderHtml: deps.rasterize }
  const renderer = createJobRenderer({ db, settings: deps.settings, rasterize: deps.rasterize, logo: deps.logo })

  const queue = createPrintQueue({
    db,
    clock,
    eventBus: deps.eventBus,
    log: deps.log,
    schedule: deps.schedule,
    backoffMs: deps.backoffMs,
    pollIntervalMs: deps.pollIntervalMs,
    async send(job, printer) {
      const out = await renderer.render(job, printer)
      if (out !== null) await createDriver(printer, env).send(out)
    }
  })

  return {
    queue,
    async testPrint(printerId) {
      const printer = readPrinter(db, printerId)
      if (!printer) return failure('printer_not_found')
      try {
        const doc = testPageDoc(printer, { businessName: deps.settings.get('business.legal').nomCommercial, now: clock.now().toISOString() })
        await createDriver(printer, env).send(await docToDriverJob(doc, printer, deps.rasterize))
        return { ok: true, value: null }
      } catch (error) {
        return failure('print_failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
