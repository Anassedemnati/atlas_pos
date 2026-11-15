import type { TicketDto, TicketSnapshot } from '@shared/dto'
import type { Database } from '../connection'
import type { Tx } from '../uow'

interface TicketRow {
  id: string
  kind: 'sale' | 'credit'
  number: number
  label: string
  order_id: string
  day_id: string
  ref_ticket_id: string | null
  closed_at: string
  user_id: string
  total_cents: number
  snapshot_json: string
  reprint_count: number
}

const toTicket = (row: TicketRow): TicketDto => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  label: row.label,
  orderId: row.order_id,
  dayId: row.day_id,
  refTicketId: row.ref_ticket_id,
  closedAt: row.closed_at,
  userId: row.user_id,
  totalCents: row.total_cents,
  reprintCount: row.reprint_count,
  snapshot: JSON.parse(row.snapshot_json) as TicketSnapshot
})

/** Tickets are immutable once inserted (database triggers); only the reprint counter moves. */
export interface TicketsRepo {
  get(id: string): TicketDto | undefined
  /** The credit note that cancels this ticket. */
  creditOf(ticketId: string): string | undefined
  /** The sale tickets and credit notes of a business day, in the order they were issued. */
  listOfDay(dayId: string): TicketDto[]
  insert(tx: Tx, ticket: TicketDto): void
  addReprint(tx: Tx, id: string): void
}

export function createTicketsRepo(db: Database): TicketsRepo {
  return {
    get(id) {
      const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
      return row ? toTicket(row) : undefined
    },

    creditOf: (ticketId) =>
      (
        db.prepare("SELECT id FROM tickets WHERE kind = 'credit' AND ref_ticket_id = ?").get(ticketId) as
          | { id: string }
          | undefined
      )?.id,

    listOfDay: (dayId) =>
      (db.prepare('SELECT * FROM tickets WHERE day_id = ? ORDER BY closed_at, rowid').all(dayId) as TicketRow[]).map(toTicket),

    insert(tx, t) {
      tx.db
        .prepare(
          `INSERT INTO tickets (id, kind, number, label, order_id, day_id, ref_ticket_id, closed_at, user_id,
                                total_cents, snapshot_json, reprint_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          t.id,
          t.kind,
          t.number,
          t.label,
          t.orderId,
          t.dayId,
          t.refTicketId,
          t.closedAt,
          t.userId,
          t.totalCents,
          JSON.stringify(t.snapshot),
          t.reprintCount
        )
    },

    addReprint(tx, id) {
      tx.db.prepare('UPDATE tickets SET reprint_count = reprint_count + 1 WHERE id = ?').run(id)
    }
  }
}
