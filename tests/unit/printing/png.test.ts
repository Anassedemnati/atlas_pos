import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeMonoPng } from '../../../src/main/infrastructure/printing/png'

/** The chunks of a PNG: type, data, and whether the stored CRC matches. */
function chunks(png: Buffer): { type: string; data: Buffer; crcOk: boolean }[] {
  const out: { type: string; data: Buffer; crcOk: boolean }[] = []
  for (let i = 8; i < png.length; ) {
    const length = png.readUInt32BE(i)
    const type = png.toString('ascii', i + 4, i + 8)
    const data = png.subarray(i + 8, i + 8 + length)
    const crcOk = png.readUInt32BE(i + 8 + length) === crc32(png.subarray(i + 4, i + 8 + length))
    out.push({ type, data, crcOk })
    i += 12 + length
  }
  return out
}

describe('encodeMonoPng', () => {
  const bitmap = { width: 10, height: 2, data: Uint8Array.from([0xff, 0xc0, 0x00, 0x00]) }

  it('writes a valid 1-bit grayscale PNG', () => {
    const png = encodeMonoPng(bitmap)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const parts = chunks(png)
    expect(parts.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(parts.every((c) => c.crcOk)).toBe(true)
    const ihdr = parts[0]!.data
    expect(ihdr.readUInt32BE(0)).toBe(10)
    expect(ihdr.readUInt32BE(4)).toBe(2)
    expect([ihdr[8], ihdr[9]]).toEqual([1, 0])
  })

  it('stores black as 0: the bits are inverted and every row starts with filter 0', () => {
    const raw = inflateSync(chunks(encodeMonoPng(bitmap)).find((c) => c.type === 'IDAT')!.data)
    // row 0 is all black (ff c0) -> 00 00 after inversion with the padding bits white; row 1 all white
    expect([...raw]).toEqual([0, 0x00, 0x3f, 0, 0xff, 0xff])
  })
})
