import type { PrinterDraft } from '@shared/setup/draft'
import type { Result } from '@shared/result'
import type { Clock } from '../../ports'
import { createDriver, type DriverEnv } from '../../../infrastructure/printing/drivers/factory'
import { EscPos } from '../../../infrastructure/printing/escpos'
import { docToDriverJob } from '../../../infrastructure/printing/render-job'
import { testPageDoc } from '../../../infrastructure/printing/templates/test-page'
import type { PrinterRow, RenderHtmlToBitmap } from '../../../infrastructure/printing/types'
import { refuse } from '../users/outcome'

export interface PrinterTestDeps extends Omit<DriverEnv, 'renderHtml' | 'clock'> {
  clock: Clock
  rasterize: RenderHtmlToBitmap
}

/**
 * Tests a printer of the draft, which has no database row yet: the test page (or a drawer pulse) goes
 * straight to its driver. A virtual printer writes `<data>/prints/<time>-<name>.bin`. Never throws.
 */
export async function testDraftPrinter(
  deps: PrinterTestDeps,
  printer: PrinterDraft,
  options: { businessName: string; action: 'page' | 'drawer' }
): Promise<Result<null>> {
  const row: PrinterRow = {
    id: printer.tempId,
    name: printer.name.trim() || printer.tempId,
    kind: printer.kind,
    address: printer.kind === 'virtual' ? '' : printer.address.trim(),
    widthMm: printer.widthMm,
    lang: printer.lang,
    raster: printer.raster,
    role: printer.role,
    active: printer.active
  }
  try {
    const driver = createDriver(row, { ...deps, renderHtml: deps.rasterize })
    if (options.action === 'drawer') {
      await driver.send(new EscPos().init().drawerPulse().build())
    } else {
      const doc = testPageDoc(row, { businessName: options.businessName, now: deps.clock.now().toISOString() })
      await driver.send(await docToDriverJob(doc, row, deps.rasterize))
    }
    return { ok: true, value: null }
  } catch (error) {
    return refuse('print_failed', { message: error instanceof Error ? error.message : String(error) })
  }
}
