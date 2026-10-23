import type { TicketSnapshot } from '@shared/dto'
import type { Database } from '../db/connection'
import type { InvoiceDoc } from './templates/invoice-a4'

/**
 * What an invoice prints, read from its (immutable) row: the one reader of both the print queue and the PDF
 * export, so that what is printed and what is saved cannot differ. Undefined when the invoice does not exist.
 */
export function readInvoiceDoc(db: Database, invoiceId: string): InvoiceDoc | undefined {
  const row = db.prepare('SELECT number_label, created_at, customer_json, snapshot_json FROM invoices WHERE id = ?').get(invoiceId) as
    | { number_label: string; created_at: string; customer_json: string; snapshot_json: string }
    | undefined
  if (!row) return undefined
  return {
    numberLabel: row.number_label,
    createdAt: row.created_at,
    customer: JSON.parse(row.customer_json) as InvoiceDoc['customer'],
    snapshot: JSON.parse(row.snapshot_json) as TicketSnapshot
  }
}
