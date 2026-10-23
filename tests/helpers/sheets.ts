import * as XLSX from 'xlsx'
import { zipOf } from './zip'

export const HEADER = [
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
]

/** Three products over two categories: Arabic, English, decimals, a barcode, a weight item, a colour. */
export const SAMPLE: string[][] = [
  ['Boissons', 'Eau minérale 1,5 L', 'ماء معدني', 'Mineral water 1.5 L', '7,50', '20', '6111245591033', 'non', '24', '#0FA3A3'],
  ['Boissons', 'Café noir', 'قهوة', '', '12', '10', '', 'non', '', ''],
  ['Épicerie', 'Sucre en vrac', '', '', '8,00', '7', '', 'oui', '12,5', '']
]

const quote = (field: string, delimiter: string): string =>
  /["\r\n]/.test(field) || field.includes(delimiter) ? `"${field.replaceAll('"', '""')}"` : field

/** A CSV file: UTF-8, `;` by default, with the header first, CRLF line ends. */
export function csvBuffer(
  rows: string[][],
  { delimiter = ';', bom = false, header = HEADER }: { delimiter?: string; bom?: boolean; header?: string[] } = {}
): Buffer {
  const text = [header, ...rows].map((r) => r.map((f) => quote(f, delimiter)).join(delimiter)).join('\r\n') + '\r\n'
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')])
}

/** An XLSX workbook whose first sheet holds `aoa` (cells may be numbers, strings or SheetJS cell objects). */
export function xlsxBuffer(aoa: unknown[][], extraSheet = false): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Produits')
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignored']]), 'Autre')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * An XLSX written by hand, so that its `dimension` can say anything (SheetJS would write every cell
 * of a big range). Cells are inline strings in columns A to Z; `rows[0]` is row 1. `dataDescriptor`
 * leaves the sizes of every file to a descriptor after its data, as Excel writes them.
 */
export function xlsxWithDimension(rows: string[][], dimension: string, { dataDescriptor = false } = {}): Buffer {
  const sheetData = rows
    .map((cells, r) => {
      const xml = cells
        .map((text, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`)
        .join('')
      return `<row r="${r + 1}">${xml}</row>`
    })
    .join('')
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const file = (name: string, xml: string) => ({
    name,
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`),
    dataDescriptor
  })
  return zipOf([
    file(
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    ),
    file(
      '_rels/.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    file('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Produits" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}"><dimension ref="${dimension}"/><sheetData>${sheetData}</sheetData></worksheet>`)
  ])
}
