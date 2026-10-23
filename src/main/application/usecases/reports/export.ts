import * as XLSX from 'xlsx'
import type { SalesReport } from './sales'

export type ReportFormat = 'xlsx' | 'csv'

const CSV_BOM = '﻿'

/** The columns of an export, French (the language the accountant reads), one per figure the grouping has. */
const HEADERS = {
  day: ['Date', 'Jour n°', 'Z n°', 'Tickets', 'Brut (DH)', 'Remises (DH)', 'Total TTC (DH)'],
  product: ['Produit', 'Quantité', 'Total TTC (DH)'],
  category: ['Catégorie', 'Quantité', 'Total TTC (DH)'],
  user: ['Utilisateur', 'Tickets', 'Total TTC (DH)'],
  payment: ['Mode de paiement', 'Paiements', 'Total TTC (DH)']
} as const

type Cell = string | number

const dh = (cents: number): number => cents / 100
const qty = (milli: number): number => milli / 1000

/** A text a spreadsheet could take for a formula gets an apostrophe in front (names are typed by people). */
const guardText = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text)

/** The report as rows of cells: a header, the rows, then the total. */
export function reportTable(report: SalesReport): Cell[][] {
  const table: Cell[][] = [[...HEADERS[report.group]]]
  for (const row of report.rows) {
    const label = guardText(row.label.fr)
    switch (report.group) {
      case 'day':
        table.push([label, row.dayNumber ?? '', row.zNumber ?? '', row.ticketsCount ?? 0, dh(row.grossCents ?? 0), dh(row.discountsCents ?? 0), dh(row.totalCents)])
        break
      case 'product':
      case 'category':
        table.push([label, qty(row.qtyMilli ?? 0), dh(row.totalCents)])
        break
      case 'user':
        table.push([label, row.ticketsCount ?? 0, dh(row.totalCents)])
        break
      case 'payment':
        table.push([label, row.count ?? 0, dh(row.totalCents)])
        break
    }
  }
  const width = HEADERS[report.group].length
  const total: Cell[] = Array.from({ length: width }, () => '')
  total[0] = 'Total'
  total[width - 1] = dh(report.totals.totalCents)
  if (report.group === 'day') {
    total[3] = report.totals.ticketsCount
    total[4] = dh(report.totals.grossCents)
    total[5] = dh(report.totals.discountsCents)
  }
  table.push(total)
  return table
}

const csvField = (value: Cell): string => {
  const text = typeof value === 'number' ? String(value).replace('.', ',') : value
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The report as a file: a CSV (UTF-8 with a BOM so that Excel shows Arabic names, `;`, decimal comma) or an XLSX sheet. */
export function exportReport(report: SalesReport, format: ReportFormat): Buffer {
  const table = reportTable(report)
  if (format === 'csv') {
    return Buffer.from(`${CSV_BOM}${table.map((row) => row.map(csvField).join(';')).join('\r\n')}\r\n`, 'utf8')
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(table), 'Rapport')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
}

/** `rapport-produits-2026-10-01-2026-10-31.xlsx` */
export function reportFileName(report: SalesReport, format: ReportFormat): string {
  const names = { day: 'jours', product: 'produits', category: 'categories', user: 'utilisateurs', payment: 'paiements' } as const
  return `rapport-${names[report.group]}-${report.from}-${report.to}.${format}`
}
