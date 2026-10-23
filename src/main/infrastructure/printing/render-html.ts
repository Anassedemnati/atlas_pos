import { EscPos } from './escpos'
import { dotsFor } from './raster'
import type { Bitmap, RenderHtmlToBitmap } from './types'

/** The job that prints a bitmap: reset, the image in bands, a feed and the cut. */
export function bitmapJob(bitmap: Bitmap): Buffer {
  return new EscPos().init().raster(bitmap).feed(3).cut().build()
}

/**
 * An HTML document as an ESC/POS job: rendered to a bitmap as wide as the paper's printable width by the
 * `rasterize` port (Electron in the app, a fake in tests), then sent as raster. This is how Arabic, which
 * most printers cannot print as text, reaches the paper.
 */
export async function htmlToEscPos(html: string, widthMm: number, rasterize: RenderHtmlToBitmap): Promise<Buffer> {
  return bitmapJob(await rasterize(html, dotsFor(widthMm)))
}
