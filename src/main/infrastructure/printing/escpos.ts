import { CP858_PAGE, encodeCp858, foldForPrinter } from './cp858'
import { rasterBands, rasterCommand } from './raster'
import type { Bitmap } from './types'

export type Align = 'left' | 'center' | 'right'

/** Characters per line in the normal font: 48 on 80 mm paper, 32 on 58 mm. */
export const columnsFor = (widthMm: number): number => (widthMm <= 58 ? 32 : 48)

/** The least room worth wrapping a left column into beside a right one. */
const MIN_LEFT_ROOM = 8

/** Rows per `GS v 0` command: many printers drop one very tall image. */
const RASTER_BAND_ROWS = 255

/**
 * `text` cut into lines of at most `width` characters, at the spaces (a longer word is split). Blank lines
 * are kept, and the indentation a line starts with is kept on every row it wraps into.
 */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const lead = ' '.repeat(Math.min(width - 1, /^ */.exec(paragraph)![0].length))
    const room = width - lead.length
    let line = ''
    for (const word of paragraph.trim().split(' ')) {
      let rest = word
      while (rest.length > room) {
        if (line) {
          out.push(lead + line)
          line = ''
        }
        out.push(lead + rest.slice(0, room))
        rest = rest.slice(room)
      }
      if (!line) line = rest
      else if (line.length + 1 + rest.length <= room) line += ` ${rest}`
      else {
        out.push(lead + line)
        line = rest
      }
    }
    out.push(line === '' ? '' : lead + line)
  }
  return out
}

/**
 * Two columns on rows of `width` characters: `right` ends the first row, `left` fills the rest and wraps onto
 * further rows when it is too long. A `right` so wide that `left` would be squeezed to a few characters goes
 * on a row of its own, right-aligned, under `left`.
 */
export function twoColumns(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1
  if (room < Math.min(left.trim().length, MIN_LEFT_ROOM)) return [...wrapText(left, width).filter((row) => row !== ''), right.padStart(width)]
  const [first = '', ...more] = wrapText(left, room)
  return [first.padEnd(room) + ' ' + right, ...more]
}

export interface EscPosOptions {
  /** Paper width: 58 or 80 mm (default 80). */
  widthMm?: number
}

/**
 * A small ESC/POS builder. Text goes out as CP858 (select it with `codepage(19)` after `init()`); a
 * character the code page lacks is folded to something printable, and widths are counted after folding.
 * `build()` returns the bytes written so far; the builder can keep being used.
 */
export class EscPos {
  private readonly chunks: Buffer[] = []
  private readonly baseColumns: number
  private widthFactor = 1

  constructor(options: EscPosOptions = {}) {
    this.baseColumns = columnsFor(options.widthMm ?? 80)
  }

  /** Characters per line at the current character size. */
  get columns(): number {
    return Math.floor(this.baseColumns / this.widthFactor)
  }

  private bytes(...values: number[]): this {
    this.chunks.push(Buffer.from(values))
    return this
  }

  /** `ESC @`: reset the printer (also back to normal size and left alignment). */
  init(): this {
    this.widthFactor = 1
    return this.bytes(0x1b, 0x40)
  }

  /** `ESC t n`: the printer's character table; `19` is CP858, the one text is encoded in. */
  codepage(n: number = CP858_PAGE): this {
    return this.bytes(0x1b, 0x74, n)
  }

  align(a: Align): this {
    return this.bytes(0x1b, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2)
  }

  bold(on: boolean): this {
    return this.bytes(0x1b, 0x45, on ? 1 : 0)
  }

  /** `GS ! n`: character width and height multipliers; a double width halves `columns`. */
  size(w: 1 | 2, h: 1 | 2): this {
    this.widthFactor = w
    return this.bytes(0x1d, 0x21, ((w - 1) << 4) | (h - 1))
  }

  /** Prints `s` as whole lines (wrapped to the paper), ending the last with a line feed. */
  text(s: string): this {
    for (const row of wrapText(foldForPrinter(s), this.columns)) this.chunks.push(encodeCp858(row + '\n'))
    return this
  }

  /** One line with a second column against the right edge (see `twoColumns`). */
  line(cols: [string, string]): this {
    for (const row of twoColumns(foldForPrinter(cols[0]), foldForPrinter(cols[1]), this.columns)) {
      this.chunks.push(encodeCp858(row + '\n'))
    }
    return this
  }

  /** `ESC d n`: print and feed `n` lines. */
  feed(n: number): this {
    return this.bytes(0x1b, 0x64, n)
  }

  /** `GS V 66 0`: feed to the cutter and cut. */
  cut(): this {
    return this.bytes(0x1d, 0x56, 0x42, 0x00)
  }

  /** `ESC p 0 25 250`: the cash drawer pulse on connector pin 2. */
  drawerPulse(): this {
    return this.bytes(0x1b, 0x70, 0x00, 0x19, 0xfa)
  }

  /** The bitmap, in bands of at most 255 rows. */
  raster(bitmap: Bitmap): this {
    for (const band of rasterBands(bitmap, RASTER_BAND_ROWS)) this.chunks.push(rasterCommand(band))
    return this
  }

  build(): Buffer {
    return Buffer.concat(this.chunks)
  }
}
