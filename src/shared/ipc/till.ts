import { z } from 'zod'
import type { OrderDto, OrderType } from '../dto'
import { def, id, none } from './define'

/** An order still open or parked, as the floor plan and the takeaway / delivery lists show it. */
export interface OrderSummaryDto {
  id: string
  type: OrderType
  status: 'open' | 'parked'
  tableId: string | null
  tableLabel: string | null
  covers: number
  orderNumber: number | null
  openedAt: string
  userId: string
  totalCents: number
  paidCents: number
  linesCount: number
  /** The pre-bill was printed: the floor plan shows the table in amber. */
  billRequested: boolean
}

/** A closed ticket (a sale or a credit note) as the Tickets screen lists it. */
export interface TicketRowDto {
  id: string
  kind: 'sale' | 'credit'
  number: number
  label: string
  closedAt: string
  userName: string
  totalCents: number
  orderType: OrderType
  orderNumber: number | null
  tableLabel: string | null
  /** A sale that a credit note cancelled. */
  cancelled: boolean
  /** On a credit note: the label of the ticket it cancels. */
  refLabel: string | null
  reprintCount: number
}

export interface ZHistoryDto {
  zId: string
  dayId: string
  zNumber: number
  dayNumber: number
  closedAt: string
  ticketsCount: number
  totalCents: number
}

/** What the till screens need beyond the core channels: order lists, the pre-bill, ticket search, Z history. */
export const tillChannels = {
  /** Every open or parked order, oldest first. */
  'orders.list': def<OrderSummaryDto[]>()(none, 'session'),
  /** Prints the pre-bill (addition) of an open order on the receipt printer and marks it bill-requested. */
  'orders.printPrebill': def<OrderDto>()(z.strictObject({ orderId: id }), 'session'),
  /**
   * The tickets of a business day, newest first: `dayId`, else the open day (the last one when none is open).
   * With `q` and no `dayId`, every ticket whose number or label contains it.
   */
  'tickets.list': def<TicketRowDto[]>()(
    z.strictObject({ dayId: id.optional(), q: z.string().max(40).optional() }),
    'session'
  ),
  /** The closed days, newest first. */
  'days.history': def<ZHistoryDto[]>()(none, { permission: 'report.x' }),
  /** Prints the stored Z of a closed day again. */
  'days.reprintZ': def<true>()(z.strictObject({ zId: id }), { permission: 'day.close' }),
  /** The language of the signed-in user. */
  'users.setLang': def<true>()(z.strictObject({ lang: z.enum(['fr', 'ar', 'en']) }), 'session')
}
