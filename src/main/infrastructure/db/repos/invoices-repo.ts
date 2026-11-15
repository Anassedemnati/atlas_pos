import type { InvoiceCustomerDto, InvoiceDto, TicketSnapshot } from '@shared/dto'
import type { Database } from '../connection'
import type { Tx } from '../uow'

interface InvoiceRow {
  id: string
  number_label: string
  ticket_id: string
  customer_json: string
  created_at: string
  user_id: string
  snapshot_json: string
}

/** An invoice as it is stored: the customer and the ticket snapshot are frozen JSON. */
export interface NewInvoice {
  id: string
  numberLabel: string
  ticketId: string
  customer: InvoiceCustomerDto
  createdAt: string
  userId: string
  snapshot: TicketSnapshot
}

const toInvoice = (row: InvoiceRow): InvoiceDto => {
  const snapshot = JSON.parse(row.snapshot_json) as TicketSnapshot
  return {
    id: row.id,
    numberLabel: row.number_label,
    ticketId: row.ticket_id,
    ticketLabel: snapshot.label,
    createdAt: row.created_at,
    userId: row.user_id,
    totalCents: snapshot.totals.totalCents,
    customer: JSON.parse(row.customer_json) as InvoiceCustomerDto
  }
}

const LIST_LIMIT = 200

/** Invoices are immutable once inserted (database triggers). */
export interface InvoicesRepo {
  get(id: string): InvoiceDto | undefined
  ofTicket(ticketId: string): InvoiceDto | undefined
  /** The invoices of these tickets, or the latest ones when no ticket is named. Newest first. */
  list(ticketIds?: readonly string[]): InvoiceDto[]
  insert(tx: Tx, invoice: NewInvoice): void
}

export function createInvoicesRepo(db: Database): InvoicesRepo {
  return {
    get(id) {
      const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined
      return row ? toInvoice(row) : undefined
    },

    ofTicket(ticketId) {
      const row = db.prepare('SELECT * FROM invoices WHERE ticket_id = ?').get(ticketId) as InvoiceRow | undefined
      return row ? toInvoice(row) : undefined
    },

    list(ticketIds) {
      const rows =
        ticketIds === undefined
          ? (db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, rowid DESC LIMIT ?').all(LIST_LIMIT) as InvoiceRow[])
          : ticketIds.length === 0
            ? []
            : (db
                .prepare(`SELECT * FROM invoices WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')}) ORDER BY created_at DESC, rowid DESC`)
                .all(...ticketIds) as InvoiceRow[])
      return rows.map(toInvoice)
    },

    insert(tx, invoice) {
      tx.db
        .prepare(
          `INSERT INTO invoices (id, number_label, ticket_id, customer_json, created_at, user_id, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(invoice.id, invoice.numberLabel, invoice.ticketId, JSON.stringify(invoice.customer), invoice.createdAt, invoice.userId, JSON.stringify(invoice.snapshot))
    }
  }
}
