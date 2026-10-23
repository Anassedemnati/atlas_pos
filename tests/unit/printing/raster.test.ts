import { describe, expect, it } from 'vitest'
import { bgraToRgba, decodeRasterCommands, rasterBands, rasterCommand, toMonochrome } from '../../../src/main/infrastructure/printing/raster'

const rgbaOf = (width: number, height: number, black: (x: number, y: number) => boolean): Uint8Array => {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = black(x, y) ? 0 : 255
      data.set([v, v, v, 255], (y * width + x) * 4)
    }
  }
  return data
}

describe('toMonochrome', () => {
  it('packs a 16x2 black/white image MSB first, 1 = black', () => {
    // row 0: left half black; row 1: every other pixel black, starting black
    const rgba = rgbaOf(16, 2, (x, y) => (y === 0 ? x < 8 : x % 2 === 0))
    const bitmap = toMonochrome(rgba, 16, 2)
    expect(bitmap.width).toBe(16)
    expect(bitmap.height).toBe(2)
    expect([...bitmap.data]).toEqual([0xff, 0x00, 0xaa, 0xaa])
  })

  it('pads a width that is not a multiple of 8 with white', () => {
    const bitmap = toMonochrome(rgbaOf(10, 1, () => true), 10, 1)
    expect([...bitmap.data]).toEqual([0xff, 0xc0])
  })

  it('uses the luma against the threshold (default 160)', () => {
    const grey = (v: number): Uint8Array => Uint8Array.from([v, v, v, 255])
    expect(toMonochrome(grey(159), 1, 1).data[0]).toBe(0x80)
    expect(toMonochrome(grey(160), 1, 1).data[0]).toBe(0x00)
    expect(toMonochrome(grey(200), 1, 1, 220).data[0]).toBe(0x80)
  })

  it('treats a transparent pixel as white', () => {
    expect(toMonochrome(Uint8Array.from([0, 0, 0, 0]), 1, 1).data[0]).toBe(0x00)
  })

  it('refuses a buffer that does not match the size', () => {
    expect(() => toMonochrome(new Uint8Array(7), 1, 2)).toThrow(/size/)
  })
})

describe('rasterCommand', () => {
  it('is GS v 0 m xL xH yL yH then the rows', () => {
    const bitmap = toMonochrome(rgbaOf(16, 2, (x, y) => (y === 0 ? x < 8 : x % 2 === 0)), 16, 2)
    expect(rasterCommand(bitmap).toString('hex')).toBe('1d763000' + '0200' + '0200' + 'ff00aaaa')
  })

  it('writes the byte width and the height as 16-bit little endian', () => {
    const bitmap = { width: 576, height: 300, data: new Uint8Array(72 * 300) }
    expect(rasterCommand(bitmap).subarray(0, 8).toString('hex')).toBe('1d76300048002c01')
  })
})

describe('rasterBands', () => {
  it('slices a tall bitmap into bands of at most N rows that put together give the original', () => {
    const data = Uint8Array.from({ length: 2 * 10 }, (_, i) => i)
    const bands = rasterBands({ width: 16, height: 10, data }, 4)
    expect(bands.map((b) => b.height)).toEqual([4, 4, 2])
    expect(Buffer.concat(bands.map((b) => Buffer.from(b.data)))).toEqual(Buffer.from(data))
  })
})

describe('bgraToRgba', () => {
  it('swaps blue and red', () => {
    expect([...bgraToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))]).toEqual([3, 2, 1, 4, 7, 6, 5, 8])
  })
})

describe('decodeRasterCommands', () => {
  it('reads back the images of a job, stacked, ignoring other commands and bytes that look like commands', () => {
    // A row whose data contains 1D 76 30 must not confuse the scan.
    const a = { width: 24, height: 2, data: Uint8Array.from([0x1d, 0x76, 0x30, 0x00, 0x00, 0x00]) }
    const b = { width: 24, height: 1, data: Uint8Array.from([0xff, 0xff, 0xff]) }
    const job = Buffer.concat([Buffer.from('1b40', 'hex'), rasterCommand(a), Buffer.from('1b6403', 'hex'), rasterCommand(b), Buffer.from('1d564200', 'hex')])
    const decoded = decodeRasterCommands(job)!
    expect(decoded.width).toBe(24)
    expect(decoded.height).toBe(3)
    expect([...decoded.data]).toEqual([...a.data, ...b.data])
  })

  it('is undefined for a job without raster', () => {
    expect(decodeRasterCommands(Buffer.from('1b40410a', 'hex'))).toBeUndefined()
  })
})
