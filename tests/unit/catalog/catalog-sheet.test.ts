import { describe, expect, it } from 'vitest'
import type { ImportRow } from '../../../src/shared/dto'
import { parseCatalogSheet } from '../../../src/main/infrastructure/import/catalog-sheet'
import { HEADER, SAMPLE, csvBuffer, xlsxBuffer, xlsxWithDimension } from '../../helpers/sheets'
import { zipOf } from '../../helpers/zip'

const row = (fields: Record<number, string>, base = SAMPLE[0]!): string[] => base.map((v, i) => fields[i] ?? v)

const SAMPLE_ROWS: ImportRow[] = [
  {
    row: 2,
    category: 'Boissons',
    nameFr: 'Eau minérale 1,5 L',
    nameAr: 'ماء معدني',
    nameEn: 'Mineral water 1.5 L',
    priceCents: 750,
    vatBp: 2000,
    barcode: '6111245591033',
    soldByWeight: false,
    stockMilli: 24000,
    color: '#0FA3A3'
  },
  { row: 3, category: 'Boissons', nameFr: 'Café noir', nameAr: 'قهوة', priceCents: 1200, vatBp: 1000, soldByWeight: false },
  { row: 4, category: 'Épicerie', nameFr: 'Sucre en vrac', priceCents: 800, vatBp: 700, soldByWeight: true, stockMilli: 12500 }
]

describe('parseCatalogSheet: values', () => {
  it('reads the price "70,00" as 7000 centimes', () => {
    const { rows, errors } = parseCatalogSheet(csvBuffer([row({ 4: '70,00' })]), 'catalogue.csv')
    expect(errors).toEqual([])
    expect(rows[0]?.priceCents).toBe(7000)
  })

  it('reads every column of a row', () => {
    const { rows, errors } = parseCatalogSheet(csvBuffer(SAMPLE), 'catalogue.csv')
    expect(errors).toEqual([])
    expect(rows).toEqual(SAMPLE_ROWS)
  })

  it('accepts amounts with a point, a thousands separator, no decimals', () => {
    const prices = ['38', '38.5', '1 200,00', '1200,5', '0']
    const { rows, errors } = parseCatalogSheet(csvBuffer(prices.map((p) => row({ 4: p, 6: '' }))), 'c.csv')
    expect(errors).toEqual([])
    expect(rows.map((r) => r.priceCents)).toEqual([3800, 3850, 120000, 120050, 0])
  })

  it('flags an unknown VAT rate on its row, field tva', () => {
    const { rows, errors } = parseCatalogSheet(csvBuffer([SAMPLE[0]!, row({ 5: '15' }, SAMPLE[1]!)]), 'c.csv')
    expect(errors).toEqual([{ row: 3, field: 'tva', messageKey: 'errors.import_invalid_vat' }])
    expect(rows.map((r) => r.row)).toEqual([2])
  })

  it('accepts the five VAT rates, also written 20 % or 20,0', () => {
    const rates = ['20', '14', '10', '7', '0', '20 %', '20,0']
    const { rows, errors } = parseCatalogSheet(csvBuffer(rates.map((t) => row({ 5: t, 6: '' }))), 'c.csv')
    expect(errors).toEqual([])
    expect(rows.map((r) => r.vatBp)).toEqual([2000, 1400, 1000, 700, 0, 2000, 2000])
  })

  it('flags a barcode repeated within the file on the second row', () => {
    const { rows, errors } = parseCatalogSheet(
      csvBuffer([SAMPLE[0]!, row({ 1: 'Autre eau' }), row({ 6: '6111245591040' })]),
      'c.csv'
    )
    expect(errors).toEqual([{ row: 3, field: 'code_barres', messageKey: 'errors.import_duplicate_barcode' }])
    expect(rows.map((r) => r.row)).toEqual([2, 4])
  })

  it.each([
    ['prix', 4, 'abc', 'errors.import_invalid_price'],
    ['prix', 4, '-5', 'errors.import_invalid_price'],
    ['prix', 4, '1,234', 'errors.import_invalid_price'],
    ['prix', 4, '', 'errors.import_required'],
    ['tva', 5, '', 'errors.import_required'],
    ['name_fr', 1, '  ', 'errors.import_required'],
    ['categorie', 0, '', 'errors.import_required'],
    ['code_barres', 6, 'abc def', 'errors.import_invalid_barcode'],
    ['code_barres', 6, '1'.repeat(33), 'errors.import_invalid_barcode'],
    ['au_poids', 7, 'peut-être', 'errors.import_invalid_weight_flag'],
    ['stock', 8, '-3', 'errors.import_invalid_stock'],
    ['stock', 8, '1,2345', 'errors.import_invalid_stock'],
    ['couleur', 9, 'rouge', 'errors.import_invalid_color'],
    ['couleur', 9, '#12345', 'errors.import_invalid_color']
  ])('flags a bad %s (%s = "%s")', (field, index, value, messageKey) => {
    const { rows, errors } = parseCatalogSheet(csvBuffer([row({ [index]: value })]), 'c.csv')
    expect(errors).toEqual([{ row: 2, field, messageKey }])
    expect(rows).toEqual([])
  })

  it('refuses a name or a category of more than 200 characters, accepts 200', () => {
    const long = 'é'.repeat(201)
    const ok200 = 'é'.repeat(200)
    const { rows, errors } = parseCatalogSheet(
      csvBuffer([
        row({ 0: long, 6: '1' }),
        row({ 1: long, 6: '2' }),
        row({ 2: long, 6: '3' }),
        row({ 3: long, 6: '4' }),
        row({ 0: ok200, 1: ok200, 2: ok200, 3: ok200, 6: '5' })
      ]),
      'c.csv'
    )
    expect(errors).toEqual([
      { row: 2, field: 'categorie', messageKey: 'errors.import_too_long' },
      { row: 3, field: 'name_fr', messageKey: 'errors.import_too_long' },
      { row: 4, field: 'name_ar', messageKey: 'errors.import_too_long' },
      { row: 5, field: 'name_en', messageKey: 'errors.import_too_long' }
    ])
    expect(rows.map((r) => r.row)).toEqual([6])
  })

  it('reports every problem of a row, in column order', () => {
    const { errors } = parseCatalogSheet(csvBuffer([row({ 4: 'x', 5: '15', 9: 'bleu' })]), 'c.csv')
    expect(errors.map((e) => e.field)).toEqual(['prix', 'tva', 'couleur'])
  })

  it('treats a blank au_poids as no, accepts oui/non in any case', () => {
    const { rows } = parseCatalogSheet(csvBuffer(['', 'OUI', ' Non '].map((v) => row({ 7: v, 6: '' }))), 'c.csv')
    expect(rows.map((r) => r.soldByWeight)).toEqual([false, true, false])
  })

  it('keeps leading zeros of a barcode and never types a text as a number or a date', () => {
    const { rows, errors } = parseCatalogSheet(csvBuffer([row({ 6: '0012345', 1: '1-2' })]), 'c.csv')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ barcode: '0012345', nameFr: '1-2' })
  })
})

describe('parseCatalogSheet: VAT rates (the vat.rates setting)', () => {
  const RATES = [2000, 550, 0]
  const vats = (cells: (string | number)[], format: 'csv' | 'xlsx' = 'csv') => {
    const lines = cells.map((t, i) => row({ 5: String(t), 6: String(i + 1) }))
    return format === 'csv'
      ? parseCatalogSheet(csvBuffer(lines), 'c.csv', RATES)
      : parseCatalogSheet(xlsxBuffer([HEADER, ...lines.map((l, i) => l.map((v, c) => (c === 5 ? cells[i] : v)))]), 'c.xlsx', RATES)
  }

  it('accepts the percentage of any configured rate: 5,5 is 550', () => {
    const { rows, errors } = vats(['20', '5,5', '5.5', '5,50 %', '0', '20 %'])
    expect(errors).toEqual([])
    expect(rows.map((r) => r.vatBp)).toEqual([2000, 550, 550, 550, 0, 2000])
  })

  it('refuses a rate that is not configured, even a legal one', () => {
    const { rows, errors } = vats(['14', '7', '5,6', '10'])
    expect(rows).toEqual([])
    expect(errors.map((e) => [e.row, e.field, e.messageKey])).toEqual([2, 3, 4, 5].map((r) => [r, 'tva', 'errors.import_invalid_vat']))
  })

  it('reads workbook cells: 5.5, 20, and a percentage-formatted 0.055 or 0.2', () => {
    const { rows, errors } = vats([5.5, 20, 0.055, 0.2, 0], 'xlsx')
    expect(errors).toEqual([])
    expect(rows.map((r) => r.vatBp)).toEqual([550, 2000, 550, 2000, 0])
  })

  it('uses the default rates of the setting when none are given', () => {
    const { rows } = parseCatalogSheet(csvBuffer([row({ 5: '14' })]), 'c.csv')
    expect(rows[0]?.vatBp).toBe(1400)
    expect(parseCatalogSheet(csvBuffer([row({ 5: '5,5' })]), 'c.csv').errors).toHaveLength(1)
  })
})

describe('parseCatalogSheet: layout', () => {
  it('finds the columns by name, whatever the case, accents, spacing, order, with extra columns ignored', () => {
    const header = ['Notes', 'PRIX', 'Catégorie', 'Name FR', 'TVA', 'Code barres']
    const lines = [['x', '3,50', 'Snacks', 'Chips', '20', '123']]
    const { rows, errors } = parseCatalogSheet(csvBuffer(lines, { header }), 'c.csv')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { row: 2, category: 'Snacks', nameFr: 'Chips', priceCents: 350, vatBp: 2000, barcode: '123', soldByWeight: false }
    ])
  })

  it('names the required columns that are missing, on the header row, and reads no rows', () => {
    const { rows, errors } = parseCatalogSheet(
      csvBuffer([['Snacks', 'Chips']], { header: ['categorie', 'name_fr'] }),
      'c.csv'
    )
    expect(rows).toEqual([])
    expect(errors).toEqual([
      { row: 1, field: 'prix', messageKey: 'errors.import_missing_column' },
      { row: 1, field: 'tva', messageKey: 'errors.import_missing_column' }
    ])
  })

  it('skips blank rows but keeps the sheet row numbers', () => {
    const blank = ['', '', '', '', '', '', '', '', '', '']
    const { rows, errors } = parseCatalogSheet(csvBuffer([SAMPLE[0]!, blank, SAMPLE[1]!]), 'c.csv')
    expect(errors).toEqual([])
    expect(rows.map((r) => r.row)).toEqual([2, 4])
  })

  it('gives no rows and no error for a sheet with only a header', () => {
    expect(parseCatalogSheet(csvBuffer([]), 'c.csv')).toEqual({ rows: [], errors: [] })
  })
})

describe('parseCatalogSheet: CSV', () => {
  it.each([
    [';', false],
    [',', false],
    [';', true],
    [',', true],
    ['\t', false]
  ])('detects the delimiter %j (BOM %s)', (delimiter, bom) => {
    const { rows, errors } = parseCatalogSheet(csvBuffer(SAMPLE, { delimiter, bom }), 'c.csv')
    expect(errors).toEqual([])
    expect(rows).toEqual(SAMPLE_ROWS)
  })

  it('reads quoted fields: a delimiter, a doubled quote and a line break inside a name', () => {
    const lines = [row({ 1: 'Lait "demi"; écrémé\nUHT' })]
    const { rows } = parseCatalogSheet(csvBuffer(lines), 'c.csv')
    expect(rows[0]?.nameFr).toBe('Lait "demi"; écrémé\nUHT')
  })

  it('reads UTF-8 with and without a BOM identically', () => {
    const a = parseCatalogSheet(csvBuffer(SAMPLE, { bom: true }), 'c.csv')
    const b = parseCatalogSheet(csvBuffer(SAMPLE, { bom: false }), 'c.csv')
    expect(a).toEqual(b)
    expect(a.rows[0]?.nameAr).toBe('ماء معدني')
  })

  it('strips the apostrophe an export puts before a text that could be read as a formula', () => {
    const lines = [row({ 1: "'=1+1", 2: "'-- كبير --" })]
    const { rows } = parseCatalogSheet(csvBuffer(lines), 'c.csv')
    expect(rows[0]).toMatchObject({ nameFr: '=1+1', nameAr: '-- كبير --' })
  })
})

describe('parseCatalogSheet: XLSX', () => {
  const aoa = (rows: string[][]): unknown[][] => [HEADER, ...rows]

  it('gives the same rows as the CSV of the same sheet, Arabic included', () => {
    const fromXlsx = parseCatalogSheet(xlsxBuffer(aoa(SAMPLE)), 'catalogue.xlsx')
    const fromCsv = parseCatalogSheet(csvBuffer(SAMPLE), 'catalogue.csv')
    expect(fromXlsx.errors).toEqual([])
    expect(fromXlsx.rows).toEqual(fromCsv.rows)
    expect(fromXlsx.rows).toEqual(SAMPLE_ROWS)
  })

  it('reads the first sheet only', () => {
    const { rows } = parseCatalogSheet(xlsxBuffer(aoa(SAMPLE), true), 'c.xlsx')
    expect(rows).toHaveLength(3)
  })

  it('reads numeric cells: prices, VAT, stock, a barcode', () => {
    const cells = ['Boissons', 'Eau', '', '', 70.3, 20, 6111245591033, 'non', 2.5, '']
    const { rows, errors } = parseCatalogSheet(xlsxBuffer([HEADER, cells]), 'c.xlsx')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ priceCents: 7030, vatBp: 2000, barcode: '6111245591033', stockMilli: 2500 })
  })

  it('refuses a numeric price with more than two decimals', () => {
    const cells = ['Boissons', 'Eau', '', '', 70.005, 20, '', '', '', '']
    const { errors } = parseCatalogSheet(xlsxBuffer([HEADER, cells]), 'c.xlsx')
    expect(errors).toEqual([{ row: 2, field: 'prix', messageKey: 'errors.import_invalid_price' }])
  })

  it('refuses a barcode stored as a number in exponent form', () => {
    const cells = ['Boissons', 'Eau', '', '', 7, 20, 1.5e30, '', '', '']
    const { errors } = parseCatalogSheet(xlsxBuffer([HEADER, cells]), 'c.xlsx')
    expect(errors).toEqual([{ row: 2, field: 'code_barres', messageKey: 'errors.import_invalid_barcode' }])
  })

  it('reads the stored value of a formula cell and never evaluates the formula', () => {
    const price = { t: 'n', v: 70, f: '1+1' }
    const name = { t: 's', v: '=HYPERLINK("http://x","clic")' }
    const cells = ['Boissons', name, '', '', price, 20, '', '', '', '']
    const { rows, errors } = parseCatalogSheet(xlsxBuffer([HEADER, cells]), 'c.xlsx')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ priceCents: 7000, nameFr: '=HYPERLINK("http://x","clic")' })
  })

  it('numbers the rows of a sheet that starts below the first line', () => {
    const { rows } = parseCatalogSheet(xlsxBuffer([[], [], HEADER, SAMPLE[0]!]), 'c.xlsx')
    expect(rows.map((r) => r.row)).toEqual([4])
  })
})

describe('parseCatalogSheet: hostile files', () => {
  const fileError = (messageKey: string) => ({ rows: [], errors: [{ row: 0, field: 'file', messageKey }] })

  it('refuses a file over 5 MB before reading it', () => {
    expect(parseCatalogSheet(Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), 'big.csv')).toEqual(fileError('errors.import_too_large'))
    expect(parseCatalogSheet(Buffer.alloc(5 * 1024 * 1024 + 1), 'big.xlsx')).toEqual(fileError('errors.import_too_large'))
  })

  it('accepts 5000 rows and refuses 5001', () => {
    const many = (n: number): string[][] => Array.from({ length: n }, (_, i) => row({ 1: `P${i}`, 6: String(i + 1) }))
    expect(parseCatalogSheet(csvBuffer(many(5000)), 'c.csv').rows).toHaveLength(5000)
    expect(parseCatalogSheet(csvBuffer(many(5001)), 'c.csv')).toEqual(fileError('errors.import_too_large'))
    expect(parseCatalogSheet(xlsxBuffer([HEADER, ...many(5001)]), 'c.xlsx')).toEqual(fileError('errors.import_too_large'))
  })

  it('does not count blank rows against the limit', () => {
    const blank = ['', '', '', '', '', '', '', '', '', '']
    const lines = [...Array.from({ length: 6000 }, () => blank), SAMPLE[0]!]
    expect(parseCatalogSheet(csvBuffer(lines), 'c.csv').rows).toHaveLength(1)
  })

  it('reads a hand-written workbook (the helper behind the next test)', () => {
    const file = xlsxWithDimension([HEADER, ...SAMPLE], 'A1:J4')
    expect(parseCatalogSheet(file, 'c.xlsx')).toEqual({ rows: SAMPLE_ROWS, errors: [] })
  })

  it('does not expand a sheet to the width its dimension claims (A1:XFD5001 is 82 million cells)', () => {
    const products = Array.from({ length: 5000 }, (_, i) => row({ 1: `Produit ${i}`, 6: String(i + 1) }))
    const file = xlsxWithDimension([HEADER, ...products], 'A1:XFD5001')
    expect(file.length).toBeLessThan(500_000)

    const started = Date.now()
    const { rows, errors } = parseCatalogSheet(file, 'wide.xlsx')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(5000)
    expect(rows[4999]).toMatchObject({ row: 5001, nameFr: 'Produit 4999', barcode: '5000' })
  })

  it('reads the first 64 columns only', () => {
    const wide = [...HEADER.slice(0, 5), ...Array.from({ length: 60 }, () => ''), 'tva']
    const cells = [...SAMPLE[0]!.slice(0, 5), ...Array.from({ length: 60 }, () => ''), '20']
    expect(parseCatalogSheet(xlsxBuffer([wide, cells]), 'c.xlsx').errors).toEqual([
      { row: 1, field: 'tva', messageKey: 'errors.import_missing_column' }
    ])
  })

  describe('a workbook that expands past 50 MB', () => {
    const MB = 1024 * 1024
    const sheetXml = (size: number) => ({ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(size, 'a') })

    it('is refused as too large though it is a few KB: one highly compressible file', () => {
      const bomb = zipOf([sheetXml(51 * MB)])
      expect(bomb.length).toBeLessThan(200_000)
      expect(parseCatalogSheet(bomb, 'bomb.xlsx')).toEqual(fileError('errors.import_too_large'))
    })

    it('is refused when the files together are over the limit', () => {
      const bomb = zipOf([0, 1, 2].map((i) => ({ ...sheetXml(20 * MB), name: `xl/worksheets/sheet${i}.xml` })))
      expect(parseCatalogSheet(bomb, 'bomb.xlsx')).toEqual(fileError('errors.import_too_large'))
    })

    it('is refused when the directory lists the same file again and again', () => {
      const bomb = zipOf([{ ...sheetXml(2 * MB), listedTimes: 40 }])
      expect(parseCatalogSheet(bomb, 'bomb.xlsx')).toEqual(fileError('errors.import_too_large'))
    })

    it('counts stored (not deflated) files too', () => {
      const bomb = zipOf([{ ...sheetXml(4 * MB), method: 0, listedTimes: 20 }])
      expect(parseCatalogSheet(bomb, 'bomb.xlsx')).toEqual(fileError('errors.import_too_large'))
    })

    it('lets a 49 MB archive through to the reader (which finds no workbook in it)', () => {
      expect(parseCatalogSheet(zipOf([sheetXml(49 * MB)]), 'big.xlsx')).toEqual(fileError('errors.import_unreadable'))
    })

    it('does not mistake a real workbook for a bomb', () => {
      expect(parseCatalogSheet(xlsxBuffer([HEADER, ...SAMPLE], true), 'c.xlsx').rows).toHaveLength(3)
    })
  })

  it('refuses a sheet of more than 20 000 physical rows, blank or not', () => {
    const blank = ['', '', '', '', '', '', '', '', '', '']
    expect(parseCatalogSheet(csvBuffer(Array.from({ length: 20_001 }, () => blank)), 'c.csv')).toEqual(
      fileError('errors.import_too_large')
    )
    const aoa: unknown[][] = [HEADER, ...Array.from({ length: 20_000 }, () => []), SAMPLE[0]!]
    expect(parseCatalogSheet(xlsxBuffer(aoa), 'c.xlsx')).toEqual(fileError('errors.import_too_large'))
  })

  it('reports an unreadable file instead of throwing', () => {
    const garbage = Buffer.from('this is not a workbook')
    expect(parseCatalogSheet(garbage, 'c.xlsx')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(xlsxBuffer([HEADER]).subarray(0, 200), 'c.xlsx')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(Buffer.alloc(0), 'c.xlsx')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'c.csv')).toEqual(fileError('errors.import_unreadable'))
  })

  it('chooses the reader from the file name, not from the content', () => {
    expect(parseCatalogSheet(xlsxBuffer([HEADER, SAMPLE[0]!]), 'c.csv')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(csvBuffer(SAMPLE), 'c.xlsx')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(csvBuffer(SAMPLE), 'c.pdf')).toEqual(fileError('errors.import_unreadable'))
    expect(parseCatalogSheet(csvBuffer(SAMPLE), 'C.CSV').rows).toHaveLength(3)
  })

  it('does not let a column named __proto__ or constructor reach an object', () => {
    const header = ['__proto__', 'constructor', ...HEADER]
    const { rows, errors } = parseCatalogSheet(csvBuffer([['x', 'y', ...SAMPLE[0]!]], { header }), 'c.csv')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })
})
