import { describe, expect, it } from 'vitest'
import { EscPos, columnsFor, twoColumns, wrapText } from '../../../src/main/infrastructure/printing/escpos'
import { CP858_HIGH, encodeCp858 } from '../../../src/main/infrastructure/printing/cp858'
import { paperLines } from '../../helpers/escpos-decode'

const hex = (buf: Buffer): string => buf.toString('hex')

describe('EscPos commands', () => {
  it('init is ESC @', () => {
    expect(hex(new EscPos().init().build())).toBe('1b40')
  })

  it('drawer pulse is ESC p 0 25 250', () => {
    expect(hex(new EscPos().drawerPulse().build())).toBe('1b700019fa')
  })

  it('cut is GS V 66 0 (feed then partial cut)', () => {
    expect(hex(new EscPos().cut().build())).toBe('1d564200')
  })

  it('selects a code page with ESC t n', () => {
    expect(hex(new EscPos().codepage(19).build())).toBe('1b7413')
  })

  it('aligns, switches bold and sizes, feeds', () => {
    const buf = new EscPos().align('left').align('center').align('right').bold(true).bold(false).size(2, 2).size(1, 2).feed(3).build()
    expect(hex(buf)).toBe(['1b6100', '1b6101', '1b6102', '1b4501', '1b4500', '1d2111', '1d2101', '1b6403'].join(''))
  })

  it('builds the commands in the order they are called', () => {
    const buf = new EscPos().init().text('A').cut().build()
    expect(hex(buf)).toBe('1b40' + '410a' + '1d564200')
  })

  it('writes a raster image as GS v 0 and splits tall images in bands', () => {
    const height = 600
    const bitmap = { width: 16, height, data: new Uint8Array(2 * height).fill(0xff) }
    const buf = new EscPos().raster(bitmap).build()
    // 255 + 255 + 90 rows, each with its own 8-byte header.
    expect(buf.length).toBe(3 * 8 + 2 * height)
    expect(hex(buf.subarray(0, 8))).toBe('1d76300002' + '00ff00')
  })
})

describe('EscPos text', () => {
  it('encodes accents and the euro sign as CP858', () => {
    const encoded = encodeCp858('é à ç È ô É € ï ê û')
    expect(hex(encoded)).toBe(['82', '85', '87', 'd4', '93', '90', 'd5', '8b', '88', '96'].join('20'))
  })

  it('maps characters the code page lacks to something printable', () => {
    // narrow no-break space (the thousands separator of formatMoney), no-break space, typographic marks, an Arabic letter
    const text = String.fromCodePoint(0x31, 0x202f, 0x32, 0x33, 0x34, 0x2c, 0x35, 0x30, 0xa0, 0x44, 0x48, 0x20, 0x2019, 0x20, 0x2013, 0x20, 0x2026, 0x20, 0x153, 0x20, 0x627)
    const [row] = paperLines(new EscPos().text(text).build())
    expect(row).toBe("1 234,50 DH ' - ... oe ?")
  })

  it('ends every text with a line feed and wraps what is too long for the paper', () => {
    const lines = paperLines(new EscPos({ widthMm: 58 }).text('Brochettes de boeuf et poulet marines au citron').build())
    expect(lines).toEqual(['Brochettes de boeuf et poulet', 'marines au citron', ''])
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(32)
  })

  it('splits a word longer than the line', () => {
    const lines = paperLines(new EscPos({ widthMm: 58 }).text('X'.repeat(40)).build())
    expect(lines).toEqual(['X'.repeat(32), 'X'.repeat(8), ''])
  })
})

describe('EscPos line()', () => {
  it('columns: 48 at 80 mm and 32 at 58 mm', () => {
    expect(columnsFor(80)).toBe(48)
    expect(columnsFor(58)).toBe(32)
    expect(new EscPos({ widthMm: 80 }).columns).toBe(48)
    expect(new EscPos({ widthMm: 58 }).columns).toBe(32)
  })

  it('right-aligns the second column: exactly 48 characters at 80 mm', () => {
    const buf = new EscPos({ widthMm: 80 }).line(['Tajine poulet citron x2', '140,00']).build()
    const [row, end] = paperLines(buf)
    expect(row).toHaveLength(48)
    expect(row!.startsWith('Tajine poulet citron x2')).toBe(true)
    expect(row!.endsWith('140,00')).toBe(true)
    expect(end).toBe('')
  })

  it('is exactly 32 characters at 58 mm', () => {
    const [row] = paperLines(new EscPos({ widthMm: 58 }).line(['Tajine poulet', '140,00']).build())
    expect(row).toHaveLength(32)
  })

  it('wraps a long left column and keeps the right one on the first row', () => {
    const lines = paperLines(new EscPos({ widthMm: 58 }).line(['2 x Tajine de poulet aux citrons confits', '140,00']).build())
    expect(lines.every((l) => l.length <= 32)).toBe(true)
    expect(lines[0]).toHaveLength(32)
    expect(lines[0]!.endsWith('140,00')).toBe(true)
    expect(lines.slice(0, -1).join(' ').replace(/\s+/g, ' ')).toContain('2 x Tajine de poulet')
  })

  it('halves the columns at double width (large kitchen text)', () => {
    const doc = new EscPos({ widthMm: 80 }).size(2, 2)
    expect(doc.columns).toBe(24)
    const [row] = paperLines(doc.line(['2 x Tajine', 'x2']).build())
    expect(row).toHaveLength(24)
    expect(new EscPos({ widthMm: 80 }).size(1, 2).columns).toBe(48)
  })

  it('counts the width after mapping, not before', () => {
    const [row] = paperLines(new EscPos({ widthMm: 58 }).line(['Total', '1' + String.fromCodePoint(0x202f) + '234,50']).build())
    expect(row).toHaveLength(32)
  })
})

describe('CP858', () => {
  it('has the 128 characters of the upper half', () => {
    expect(CP858_HIGH).toHaveLength(128)
    expect(new Set(CP858_HIGH).size).toBe(128)
    expect(CP858_HIGH[0x70]).toBe(String.fromCodePoint(0xad))
    expect(hex(encodeCp858('N°²·'))).toBe('4ef8fdfa')
  })
})

describe('wrapText and indentation', () => {
  it('keeps the indentation on the rows a line wraps into', () => {
    expect(wrapText('  + Supplément de légumes grillés', 20)).toEqual(['  + Supplément de', '  légumes grillés'])
  })

  it('keeps blank lines and short text as they are', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b'])
    expect(wrapText('', 10)).toEqual([''])
  })

  it('puts a right column too wide for the left one on its own row, right-aligned', () => {
    expect(twoColumns('Total', 'X'.repeat(30), 32)).toEqual(['Total', '  ' + 'X'.repeat(30)])
    expect(twoColumns('Total', 'X'.repeat(40), 32)).toEqual(['Total', 'X'.repeat(40)])
  })
})
