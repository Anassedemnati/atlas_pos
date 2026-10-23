import type { Lang, LocalizedName } from '../names'
import type { VatRow } from '../vat'
import type { DiscountDto, LineModifierDto, OrderTotalsDto, OrderType } from './orders'
import type { CustomerDto } from './users'

// Tickets (immutable legal records), business days, X / Z reports.

/** The identity printed on every ticket (setting `business.legal`). */
export interface BusinessLegalDto {
  raisonSociale: string
  nomCommercial: string
  adresse: string
  ville: string
  telephone: string
  ice: string
  if: string
  rc: string
  patente: string
}

export interface TicketLineSnapshot {
  id: string
  productId: string
  /** The product's category when the ticket was closed (null if the product was gone). */
  categoryId: string | null
  categoryName: LocalizedName | null
  name: LocalizedName
  qtyMilli: number
  unitPriceCents: number
  modifiers: LineModifierDto[]
  note: string
  vatBp: number
  discount: DiscountDto | null
  free: boolean
  freeReason: string
  grossCents: number
  /** The line discount, or the whole gross of a free line. */
  lineDiscountCents: number
  ticketDiscountCents: number
  netCents: number
}

/**
 * Everything a ticket prints, frozen when it is closed (`tickets.snapshot_json`): a reprint and the Z
 * report read this, never the live rows. A credit note carries the original's figures negated.
 */
export interface TicketSnapshot {
  version: 1
  kind: 'sale' | 'credit'
  number: number
  /** `000123`, or `AV-000007` for a credit note. */
  label: string
  closedAt: string
  dayNumber: number
  business: BusinessLegalDto
  receipt: { lang: Lang; header: string; footer: string }
  order: {
    id: string
    type: OrderType
    number: number | null
    table: { id: string; label: string } | null
    covers: number
    note: string
  }
  customer: Omit<CustomerDto, 'createdAt' | 'notes'> | null
  user: { id: string; displayName: string }
  lines: TicketLineSnapshot[]
  ticketDiscount: DiscountDto | null
  totals: Omit<OrderTotalsDto, 'vat'>
  vat: VatRow[]
  payments: { methodCode: string; methodName: LocalizedName; amountCents: number; tenderedCents: number }[]
  paidCents: number
  changeCents: number
  /** On a credit note: the ticket it cancels, and why. */
  ref?: { ticketId: string; label: string; reason: string }
}

export interface TicketDto {
  id: string
  kind: 'sale' | 'credit'
  number: number
  label: string
  orderId: string
  dayId: string
  refTicketId: string | null
  closedAt: string
  userId: string
  totalCents: number
  reprintCount: number
  snapshot: TicketSnapshot
}

/** A business day: from the first sale after a Z closure to the next Z. */
export interface DayDto {
  id: string
  number: number
  openedAt: string
  closedAt: string | null
}

export interface DayGateDto {
  /** `must_close`: the till asks for the Z of the previous day before any new sale. */
  state: 'ok' | 'must_close'
  /** The open day; with no day open, the number the next one will get and `openedAt` null. */
  dayNumber: number
  openedAt: string | null
}

/**
 * An X report (the day so far: `zNumber` and `closedAt` null) or a Z report. Credit notes count in
 * negative, so a cancelled sale nets to zero. `grossCents - discountsCents - freeItems.cents === totalCents`.
 */
export interface ZData {
  dayNumber: number
  zNumber: number | null
  openedAt: string
  closedAt: string | null
  ticketsCount: number
  creditsCount: number
  grossCents: number
  /** Line and ticket discounts; free items are not in it (see `freeItems`). */
  discountsCents: number
  totalCents: number
  byPayment: { methodCode: string; name: LocalizedName; count: number; cents: number }[]
  byVat: VatRow[]
  byCategory: { categoryId: string | null; name: LocalizedName | null; qtyMilli: number; cents: number }[]
  byUser: { userId: string; displayName: string; ticketsCount: number; cents: number }[]
  /** Lines removed from orders of the day, at their gross. */
  voids: { count: number; cents: number }
  freeItems: { count: number; cents: number }
  /** Duplicates printed during the day. */
  reprints: number
}

/** What an invoice is made out to, copied from the customer when it was issued (a later edit of the customer never changes it). */
export interface InvoiceCustomerDto {
  name: string
  companyName: string
  address: string
  ice: string
  phone: string
}

/** An A4 invoice (`F-2026-00001`): immutable, made from one closed sale ticket. */
export interface InvoiceDto {
  id: string
  numberLabel: string
  ticketId: string
  /** The label of the ticket it is made from (`000123`). */
  ticketLabel: string
  createdAt: string
  userId: string
  /** The ticket's total TTC. */
  totalCents: number
  customer: InvoiceCustomerDto
}
