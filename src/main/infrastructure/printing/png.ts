import { deflateSync } from 'node:zlib'
import type { Bitmap } from './types'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (...parts: Buffer[]): number => {
  let c = 0xffffffff
  for (const part of parts) for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0)
  return Buffer.concat([head, data, tail])
}

/**
 * A 1-bit grayscale PNG of the bitmap (black dots black on white). PNG stores 0 as black, so the bits
 * are inverted; each row starts with filter type 0.
 */
export function encodeMonoPng(bitmap: Bitmap): Buffer {
  const bytesPerRow = Math.ceil(bitmap.width / 8)
  const raw = Buffer.alloc((bytesPerRow + 1) * bitmap.height)
  for (let y = 0; y < bitmap.height; y++) {
    const at = y * (bytesPerRow + 1)
    raw[at] = 0
    for (let x = 0; x < bytesPerRow; x++) raw[at + 1 + x] = ~bitmap.data[y * bytesPerRow + x]! & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(bitmap.width, 0)
  ihdr.writeUInt32BE(bitmap.height, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
