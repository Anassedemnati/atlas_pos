import * as XLSX from 'xlsx'

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
