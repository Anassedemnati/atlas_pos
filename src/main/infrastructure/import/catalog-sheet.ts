import * as XLSX from 'xlsx'
import type { ImportError, ImportRow, ParsedCatalogSheet } from '@shared/dto'
import {
  REQUIRED_COLUMNS,
  SHEET_COLUMNS,
  isSheetColumn,
  normalizeHeader,
  parseRowCells,
  rowToCells,
  type Cell,
  type SheetColumn
} from '../../domain/catalog/import-row'

// Reading and writing the catalogue as an Excel (.xlsx) or CSV file. A sheet is hostile input: the
// size and the number of rows are capped, the format is chosen from the file name (never guessed
// from the content), formulas are never evaluated (the stored value is read), and a file that
// cannot be read is an `errors` entry, never an exception.

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
/** Product rows (blank rows and the header do not count). */
export const MAX_IMPORT_ROWS = 5000
/** Physical rows read at most: a sheet longer than this is refused whatever it holds. */
const MAX_SHEET_ROWS = 20_000

type Format = 'xlsx' | 'csv'

interface Grid {
  /** The `rows` are consecutive sheet rows; this is the 1-based number of the first. */
  firstRow: number
  rows: Cell[][]
  /** The file has more than `MAX_SHEET_ROWS` rows. */
  truncated: boolean
}

const fileError = (messageKey: string): ParsedCatalogSheet => ({
  rows: [],
  errors: [{ row: 0, field: 'file', messageKey }]
})

const isBlank = (cells: Cell[]): boolean =>
  cells.every((cell) => cell === null || cell === undefined || String(cell).trim() === '')

// CSV ----------------------------------------------------------------------------------------------

/**
 * The delimiter is the one most used on the header line (`;` for a French Excel, `,`, or a tab), `;`
 * on a tie. Only the header is looked at: prices such as `70,00` would skew a count over the file.
 */
function detectDelimiter(text: string): string {
  const header = text.slice(0, text.search(/[\r\n]|$/))
  const count = (c: string): number => header.split(c).length - 1
  const best = [';', ',', '\t'].reduce((a, b) => (count(b) > count(a) ? b : a))
  return count(best) === 0 ? ';' : best
}

/** RFC 4180 with a lenient reading of a quote inside an unquoted field. Throws on an unterminated quote. */
function parseCsv(text: string): { records: string[][]; truncated: boolean } {
  const delimiter = detectDelimiter(text)
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  let pending = false // something of the current record has been read

  const endField = (): void => {
    record.push(field)
    field = ''
    atFieldStart = true
  }
  const endRecord = (): void => {
    endField()
    records.push(record)
    record = []
    pending = false
  }

  for (let i = 0; i < text.length; i++) {
    if (records.length >= MAX_SHEET_ROWS) return { records, truncated: true }
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    pending = true
    if (c === '"' && atFieldStart) {
      inQuotes = true
      atFieldStart = false
    } else if (c === delimiter) endField()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRecord()
    } else {
      field += c
      atFieldStart = false
    }
  }
  if (inQuotes) throw new Error('unterminated quote')
  if (pending) endRecord()
  return { records, truncated: false }
}

/**
 * An export puts an apostrophe before a text that a spreadsheet could take for a formula (it starts
 * with `=`, `+`, `-` or `@`); reading takes it off again. `'` itself is escaped the same way when
 * it precedes such a character, so every text reads back as it was written.
 */
const FORMULA_START = /^'?[=+\-@]/
const unguard = (text: string): string => (text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text)
const guard = (text: string): string => (FORMULA_START.test(text) ? `'${text}` : text)

function readCsv(buf: Uint8Array): Grid {
  // Strict UTF-8 (a BOM is dropped): a file in another encoding is refused rather than read with garbled letters.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  const { records, truncated } = parseCsv(text)
  return { firstRow: 1, rows: records.map((r) => r.map(unguard)), truncated }
}

// XLSX ---------------------------------------------------------------------------------------------

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

function readXlsx(buf: Uint8Array): Grid {
  // SheetJS reads anything as a workbook (even plain text); only a zip is an .xlsx.
  if (buf.length < 4 || ZIP_MAGIC.some((byte, i) => buf[i] !== byte)) throw new Error('not a zip file')
  const workbook = XLSX.read(buf, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellText: false,
    cellDates: false,
    bookVBA: false,
    dense: true,
    sheetRows: MAX_SHEET_ROWS
  })
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? '']
  if (!sheet) throw new Error('no sheet')
  const ref = sheet['!ref']
  if (!ref) return { firstRow: 1, rows: [], truncated: false }
  const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: '', blankrows: true })
  // SheetJS keeps the full range in `!fullref` when `sheetRows` cut the sheet short.
  return { firstRow: XLSX.utils.decode_range(ref).s.r + 1, rows, truncated: sheet['!fullref'] !== undefined }
}

// Reading ------------------------------------------------------------------------------------------

function formatOf(fileName: string): Format | undefined {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.csv')) return 'csv'
  return undefined
}

/**
 * Reads a catalogue sheet. `.xlsx` uses the first sheet, `.csv` is UTF-8 (with or without BOM) and
 * `;`, `,` or tab delimited. The first non-blank row is the header; columns are found by name
 * (`categorie`, `name_fr`, `name_ar`, `name_en`, `prix`, `tva`, `code_barres`, `au_poids`, `stock`,
 * `couleur`), extra columns are ignored. Blank rows are skipped. `rows` holds the rows that have no
 * problem; every problem is in `errors` with its sheet row (header = 1). A file that is refused as a
 * whole (`errors.import_too_large`, `errors.import_unreadable`) has `row` 0 and `field` `file`; a
 * missing required column is `errors.import_missing_column` on the header row.
 */
export function parseCatalogSheet(buf: Uint8Array, fileName: string): ParsedCatalogSheet {
  if (buf.byteLength > MAX_IMPORT_BYTES) return fileError('errors.import_too_large')
  const format = formatOf(fileName)
  if (!format) return fileError('errors.import_unreadable')

  let grid: Grid
  try {
    grid = format === 'xlsx' ? readXlsx(buf) : readCsv(buf)
  } catch {
    return fileError('errors.import_unreadable')
  }
  if (grid.truncated) return fileError('errors.import_too_large')
  return interpret(grid)
}

function interpret(grid: Grid): ParsedCatalogSheet {
  const headerIndex = grid.rows.findIndex((cells) => !isBlank(cells))
  if (headerIndex < 0) return { rows: [], errors: [] }
  const headerRow = grid.firstRow + headerIndex

  const columns = new Map<SheetColumn, number>()
  grid.rows[headerIndex]!.forEach((cell, index) => {
    const name = normalizeHeader(cell)
    if (isSheetColumn(name) && !columns.has(name)) columns.set(name, index)
  })
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column))
  if (missing.length > 0) {
    return {
      rows: [],
      errors: missing.map((field) => ({ row: headerRow, field, messageKey: 'errors.import_missing_column' }))
    }
  }

  const data: { cells: Cell[]; row: number }[] = []
  grid.rows.forEach((cells, index) => {
    if (index > headerIndex && !isBlank(cells)) data.push({ cells, row: grid.firstRow + index })
  })
  if (data.length > MAX_IMPORT_ROWS) return fileError('errors.import_too_large')

  const rows: ImportRow[] = []
  const errors: ImportError[] = []
  const barcodes = new Set<string>()
  for (const { cells, row } of data) {
    const parsed = parseRowCells((column) => cells[columns.get(column) ?? -1], row)
    for (const { field, messageKey } of parsed.failures) errors.push({ row, field, messageKey })
    if (parsed.barcode !== undefined) {
      if (barcodes.has(parsed.barcode)) {
        errors.push({ row, field: 'code_barres', messageKey: 'errors.import_duplicate_barcode' })
        continue
      }
      barcodes.add(parsed.barcode)
    }
    if (parsed.row) rows.push(parsed.row)
  }
  return { rows, errors }
}

// Writing ------------------------------------------------------------------------------------------

const CSV_BOM = '﻿'
// The text columns an export guards against formulas: category, the three names, barcode, colour.
const TEXT_COLUMNS = new Set([0, 1, 2, 3, 6, 9])

const csvField = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/**
 * The rows as a file with the import columns. CSV: UTF-8 with a BOM (Excel then shows Arabic
 * correctly), `;`, CRLF. XLSX: one sheet, every cell text, so that a barcode keeps its zeros and
 * `7,50` stays what it is. Both read back with `parseCatalogSheet` to the same rows.
 */
export function writeCatalogSheet(rows: ImportRow[], format: Format): Buffer {
  const lines = [[...SHEET_COLUMNS] as string[], ...rows.map(rowToCells)]
  if (format === 'csv') {
    const text = lines
      .map((cells, index) =>
        cells.map((value, column) => csvField(index > 0 && TEXT_COLUMNS.has(column) ? guard(value) : value)).join(';')
      )
      .join('\r\n')
    return Buffer.from(`${CSV_BOM}${text}\r\n`, 'utf8')
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(lines), 'Produits')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
}
