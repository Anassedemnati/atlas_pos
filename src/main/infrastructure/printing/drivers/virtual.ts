import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock } from '../../../application/ports'
import { encodeMonoPng } from '../png'
import { decodeRasterCommands, dotsFor } from '../raster'
import type { DriverJob, PrinterDriver, RenderHtmlToBitmap } from '../types'

/** A printer name as a file name part: lower case ASCII letters and digits, single dashes. */
export function slugOf(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'printer' : slug
}

export interface VirtualDriverOptions {
  /** `<data dir>/prints`. */
  dir: string
  printerName: string
  clock: Clock
  /** Turns an HTML job into a picture (Electron); without it only the HTML is kept. */
  renderHtml?: RenderHtmlToBitmap
  /** Paper width for that picture. Default 80 mm. */
  widthMm?: number
}

/**
 * A printer that is a folder: each job becomes `<ISO timestamp>-<printer>.bin` (the exact bytes), with a
 * `.png` of what the paper would show when the job holds a raster image or the HTML could be rendered
 * (and `.html` for a document job). So a receipt can be inspected without any hardware.
 */
export function createVirtualDriver(options: VirtualDriverOptions): PrinterDriver {
  const slug = slugOf(options.printerName)

  const exists = (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false
    )

  /**
   * Writes each extension under a name no earlier job used. On a clash the timestamp moves on by a millisecond, so
   * names stay unique and sort in the order the jobs were printed.
   */
  async function writeAll(files: [ext: string, data: Buffer | string][]): Promise<void> {
    await mkdir(options.dir, { recursive: true })
    const at = options.clock.now().getTime()
    let base = ''
    for (let bump = 0; ; bump++) {
      base = `${new Date(at + bump).toISOString().replace(/:/g, '-')}-${slug}`
      if (!(await Promise.all(files.map(([ext]) => exists(join(options.dir, `${base}.${ext}`))))).some(Boolean)) break
    }
    for (const [ext, data] of files) await writeFile(join(options.dir, `${base}.${ext}`), data, { flag: 'wx' })
  }

  return {
    kind: 'virtual',
    async send(job: DriverJob): Promise<void> {
      if (Buffer.isBuffer(job)) {
        const bitmap = decodeRasterCommands(job)
        await writeAll([['bin', job], ...(bitmap ? ([['png', encodeMonoPng(bitmap)]] as [string, Buffer][]) : [])])
        return
      }
      const bitmap = options.renderHtml ? await options.renderHtml(job.html, dotsFor(options.widthMm ?? 80)) : undefined
      await writeAll([['html', job.html], ...(bitmap ? ([['png', encodeMonoPng(bitmap)]] as [string, Buffer][]) : [])])
    }
  }
}
