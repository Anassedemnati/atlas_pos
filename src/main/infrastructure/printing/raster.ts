import type { Bitmap, DotWidth } from './types'

/** Printable dots across: 576 on 80 mm paper (72 mm at 8 dots/mm), 384 on 58 mm. */
export const dotsFor = (widthMm: number): DotWidth => (widthMm <= 58 ? 384 : 576)

/**
 * Black and white from RGBA pixels (row-major, 4 bytes each): a pixel is black when its luma, over white
 * for the transparent part, is below `threshold`. Packed MSB first, rows padded with white to whole bytes.
 */
export function toMonochrome(rgba: Uint8Array, width: number, height: number, threshold = 160): Bitmap {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || rgba.length !== width * height * 4) {
    throw new RangeError(`rgba buffer of ${rgba.length} bytes does not match the size ${width}x${height}`)
  }
  const bytesPerRow = Math.ceil(width / 8)
  const data = new Uint8Array(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = rgba[i + 3]! / 255
      const luma = 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!
      const shown = luma * alpha + 255 * (1 - alpha)
      if (shown < threshold) data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7)
    }
  }
  return { width, height, data }
}

/** A copy of `bgra` (what `NativeImage.toBitmap()` gives) in RGBA order. */
export function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    out[i] = bgra[i + 2]!
    out[i + 1] = bgra[i + 1]!
    out[i + 2] = bgra[i]!
    out[i + 3] = bgra[i + 3]!
  }
  return out
}

/** `GS v 0 m xL xH yL yH d...`: the whole bitmap as one raster command (normal density). */
export function rasterCommand(bitmap: Bitmap): Buffer {
  const bytesPerRow = Math.ceil(bitmap.width / 8)
  if (bytesPerRow > 0xffff || bitmap.height > 0xffff) throw new RangeError('bitmap too large for one raster command')
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, bitmap.height & 0xff, bitmap.height >> 8])
  return Buffer.concat([header, bitmap.data.subarray(0, bytesPerRow * bitmap.height)])
}

/** The bitmap cut into bands of at most `maxRows` rows: many printers drop one very tall image. */
export function rasterBands(bitmap: Bitmap, maxRows: number): Bitmap[] {
  const bytesPerRow = Math.ceil(bitmap.width / 8)
  const bands: Bitmap[] = []
  for (let y = 0; y < bitmap.height; y += maxRows) {
    const height = Math.min(maxRows, bitmap.height - y)
    bands.push({ width: bitmap.width, height, data: bitmap.data.subarray(y * bytesPerRow, (y + height) * bytesPerRow) })
  }
  return bands
}

const GS_V_0 = [0x1d, 0x76, 0x30]

/**
 * The raster images of an ESC/POS job (`GS v 0` blocks, read by their declared sizes so image bytes that
 * look like a command are not mistaken for one), stacked into one bitmap; undefined when there is none.
 * The virtual printer uses it to write a picture of what would have come out of the printer.
 */
export function decodeRasterCommands(job: Buffer): Bitmap | undefined {
  const images: Bitmap[] = []
  for (let i = 0; i + 8 <= job.length; ) {
    if (GS_V_0.every((byte, k) => job[i + k] === byte)) {
      const bytesPerRow = job[i + 4]! | (job[i + 5]! << 8)
      const height = job[i + 6]! | (job[i + 7]! << 8)
      const end = i + 8 + bytesPerRow * height
      if (end > job.length) break
      images.push({ width: bytesPerRow * 8, height, data: Uint8Array.from(job.subarray(i + 8, end)) })
      i = end
    } else {
      i += 1
    }
  }
  if (images.length === 0) return undefined
  const bytesPerRow = Math.max(...images.map((b) => b.width / 8))
  const height = images.reduce((sum, b) => sum + b.height, 0)
  const data = new Uint8Array(bytesPerRow * height)
  let y = 0
  for (const image of images) {
    const own = image.width / 8
    for (let row = 0; row < image.height; row++) {
      data.set(image.data.subarray(row * own, (row + 1) * own), (y + row) * bytesPerRow)
    }
    y += image.height
  }
  return { width: bytesPerRow * 8, height, data }
}
