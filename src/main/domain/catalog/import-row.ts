import { z } from 'zod'
import type { CatalogDto, ImportRow } from '@shared/dto'
import { parseMoney } from '@shared/money'
import { BarcodeRule, ColorRule, PriceCentsRule, SHEET_VAT_RATES_BP, StockMilliRule } from './fields'

// The Excel / CSV catalogue sheet: its columns, how a cell becomes a field, and the back way.

/** The columns, in the order an export writes them. Headers are matched case- and accent-insensitively. */
export const SHEET_COLUMNS = [
  'categorie',
  'name_fr',
  'name_ar',
  'name_en',
  'prix',
  'tva',
  'code_barres',
  'au_poids',
  'stock',
  'couleur'
] as const
export type SheetColumn = (typeof SHEET_COLUMNS)[number]

export const REQUIRED_COLUMNS: readonly SheetColumn[] = ['categorie', 'name_fr', 'prix', 'tva']

/** A cell as a sheet reader hands it over: text from a CSV, text or numbers from a workbook. */
export type Cell = string | number | boolean | null | undefined

/** `Catégorie ` -> `categorie`, `Code barres` -> `code_barres`. */
export function normalizeHeader(cell: Cell): string {
  return String(cell ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export const isSheetColumn = (name: string): name is SheetColumn => (SHEET_COLUMNS as readonly string[]).includes(name)

const textOf = (cell: Cell): string => (cell === null || cell === undefined ? '' : String(cell).trim())

const priceOf = (cell: Cell): number | null => {
  if (typeof cell === 'number') return parseMoney(String(cell))
  return typeof cell === 'string' ? parseMoney(cell.trim()) : null
}

const QUANTITY = /^(\d+)(?:[.,](\d{1,3}))?$/

/** `12`, `2,5`, `0.350` -> milli-units. Exact, up to 3 decimals. */
export function parseQuantityMilli(text: string): number | null {
  const match = QUANTITY.exec(text.replace(/\s/g, ''))
  if (!match) return null
  const [, whole, fraction = ''] = match
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return Number.isSafeInteger(milli) ? milli : null
}

const quantityOf = (cell: Cell): number | null => {
  if (typeof cell === 'number') return parseQuantityMilli(String(cell))
  return typeof cell === 'string' ? parseQuantityMilli(cell) : null
}

/** `20`, `20 %`, `20,0`; from a workbook also `20` or `0.2` (a cell formatted as a percentage). */
function vatOf(cell: Cell): number | null {
  const accept = (percent: number): number | null =>
    SHEET_VAT_RATES_BP.includes(percent * 100) ? percent * 100 : null
  if (typeof cell === 'number') {
    return accept(cell) ?? accept(Math.round(cell * 100 * 1e6) / 1e6)
  }
  if (typeof cell !== 'string') return null
  const match = /^(\d{1,2})(?:[.,]0+)?$/.exec(cell.replace(/\s/g, '').replace(/%$/, ''))
  return match ? accept(Number(match[1])) : null
}

export interface CellFailure {
  field: SheetColumn
  messageKey: string
}

const failure = (field: SheetColumn, reason: string): CellFailure => ({ field, messageKey: `errors.import_${reason}` })

/**
 * One data row. `cell(column)` is the cell of that column, `undefined` when the sheet has no such
 * column. Every problem of the row is reported, in column order; `row` is set only when there is none.
 * `barcode` is the row's barcode whenever that field alone is valid, so duplicates can be found even
 * in a row that fails elsewhere.
 */
export function parseRowCells(
  cell: (column: SheetColumn) => Cell,
  rowNumber: number
): { row?: ImportRow; failures: CellFailure[]; barcode?: string } {
  const failures: CellFailure[] = []
  const fail = (field: SheetColumn, reason: string): void => {
    failures.push(failure(field, reason))
  }

  const category = textOf(cell('categorie'))
  if (category === '') fail('categorie', 'required')

  const nameFr = textOf(cell('name_fr'))
  if (nameFr === '') fail('name_fr', 'required')
  const nameAr = textOf(cell('name_ar'))
  const nameEn = textOf(cell('name_en'))

  const priceText = textOf(cell('prix'))
  let priceCents = 0
  if (priceText === '') fail('prix', 'required')
  else {
    const price = priceOf(cell('prix'))
    if (price === null || !PriceCentsRule.safeParse(price).success) fail('prix', 'invalid_price')
    else priceCents = price
  }

  const vatText = textOf(cell('tva'))
  let vatBp = 0
  if (vatText === '') fail('tva', 'required')
  else {
    const vat = vatOf(cell('tva'))
    if (vat === null) fail('tva', 'invalid_vat')
    else vatBp = vat
  }

  const barcodeText = textOf(cell('code_barres'))
  let barcode: string | undefined
  if (barcodeText !== '') {
    if (BarcodeRule.safeParse(barcodeText).success) barcode = barcodeText
    else fail('code_barres', 'invalid_barcode')
  }

  const weightText = textOf(cell('au_poids')).toLowerCase()
  let soldByWeight = false
  if (weightText === 'oui') soldByWeight = true
  else if (weightText !== '' && weightText !== 'non') fail('au_poids', 'invalid_weight_flag')

  const stockText = textOf(cell('stock'))
  let stockMilli: number | undefined
  if (stockText !== '') {
    const stock = quantityOf(cell('stock'))
    if (stock === null || !StockMilliRule.safeParse(stock).success) fail('stock', 'invalid_stock')
    else stockMilli = stock
  }

  const colorText = textOf(cell('couleur'))
  let color: string | undefined
  if (colorText !== '') {
    if (ColorRule.safeParse(colorText).success) color = colorText
    else fail('couleur', 'invalid_color')
  }

  if (failures.length > 0) return { failures, ...(barcode !== undefined ? { barcode } : {}) }
  return {
    failures,
    ...(barcode !== undefined ? { barcode } : {}),
    row: {
      row: rowNumber,
      category,
      nameFr,
      ...(nameAr !== '' ? { nameAr } : {}),
      ...(nameEn !== '' ? { nameEn } : {}),
      priceCents,
      vatBp,
      ...(barcode !== undefined ? { barcode } : {}),
      soldByWeight,
      ...(stockMilli !== undefined ? { stockMilli } : {}),
      ...(color !== undefined ? { color } : {})
    }
  }
}

/**
 * An `ImportRow` that comes back from the preview screen (over IPC) is not trusted: the same rules
 * as a cell, applied to the typed values.
 */
export const ImportRowSchema = z.strictObject({
  row: z.number().int().min(1),
  category: z.string().trim().min(1),
  nameFr: z.string().trim().min(1),
  nameAr: z.string().trim().min(1).optional(),
  nameEn: z.string().trim().min(1).optional(),
  priceCents: PriceCentsRule,
  vatBp: z.number().refine((rate) => SHEET_VAT_RATES_BP.includes(rate), { message: 'not a VAT rate of the sheet' }),
  barcode: BarcodeRule.optional(),
  soldByWeight: z.boolean(),
  stockMilli: StockMilliRule.optional(),
  color: ColorRule.optional()
})

// Back to a sheet -----------------------------------------------------------------------------------

/** `7000` -> `70,00`: no thousands separator and no currency, so that it reads back as it was. */
export const formatPrice = (cents: number): string =>
  `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`

/** `2500` -> `2,5`, `12000` -> `12`. */
export function formatQuantityMilli(milli: number): string {
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${Math.trunc(milli / 1000)}${fraction === '' ? '' : `,${fraction}`}`
}

/**
 * The products the till shows (active, in an active category), in display order, as sheet rows.
 * An oversold (negative) stock is written as 0: a sheet carries a starting quantity.
 */
export function catalogToRows(catalog: Pick<CatalogDto, 'categories' | 'products'>): ImportRow[] {
  const rows: ImportRow[] = []
  for (const category of catalog.categories) {
    if (!category.active) continue
    for (const p of catalog.products) {
      if (p.categoryId !== category.id || !p.active) continue
      rows.push({
        row: rows.length + 2,
        category: category.name.fr,
        nameFr: p.name.fr,
        ...(p.name.ar ? { nameAr: p.name.ar } : {}),
        ...(p.name.en ? { nameEn: p.name.en } : {}),
        priceCents: p.priceCents,
        vatBp: p.vatBp,
        ...(p.barcode !== null ? { barcode: p.barcode } : {}),
        soldByWeight: p.soldByWeight,
        ...(p.stockTracked ? { stockMilli: Math.max(0, p.stockMilli) } : {}),
        ...(p.color !== null ? { color: p.color } : {})
      })
    }
  }
  return rows
}

/** The `ImportRow` as the ten cells of a sheet row (text, in `SHEET_COLUMNS` order). */
export const rowToCells = (r: ImportRow): string[] => [
  r.category,
  r.nameFr,
  r.nameAr ?? '',
  r.nameEn ?? '',
  formatPrice(r.priceCents),
  String(r.vatBp / 100),
  r.barcode ?? '',
  r.soldByWeight ? 'oui' : 'non',
  r.stockMilli === undefined ? '' : formatQuantityMilli(r.stockMilli),
  r.color ?? ''
]
