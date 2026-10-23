import type { LocalizedName } from '../names'
import type { VatRow } from '../vat'

// Orders at the till: lines, discounts, payments.

/** A percentage in basis points (1000 = 10 %) or a fixed amount in centimes, with its reason. */
export type DiscountDto = { kind: 'pct'; bp: number; reason: string } | { kind: 'amount'; cents: number; reason: string }

export interface LineModifierDto {
  /** The modifier; for a set-menu choice, the chosen product. */
  id: string
  name: LocalizedName
  /** Added to the unit price (a set-menu supplement); may be negative. */
  priceDeltaCents: number
  /** Set on a set-menu choice: the course it was chosen in. */
  menuCourseId?: string
}

export type OrderType = 'dine_in' | 'takeaway' | 'delivery' | 'counter'
export type OrderStatus = 'open' | 'parked' | 'closed' | 'cancelled'

export interface OrderLineDto {
  id: string
  seq: number
  productId: string
  name: LocalizedName
  qtyMilli: number
  unitPriceCents: number
  vatBp: number
  modifiers: LineModifierDto[]
  note: string
  course: number
  status: 'active' | 'void'
  voidReason: string
  /** ISO instant the line went to the kitchen. */
  sentAt: string | null
  discount: DiscountDto | null
  free: boolean
  freeReason: string
  userId: string
  createdAt: string
  /** What the line comes to on the ticket, its share of the ticket discount taken off; 0 when void. */
  netCents: number
}

export interface PaymentDto {
  id: string
  methodCode: string
  /** The part applied to the bill. */
  amountCents: number
  /** What the customer handed over (above the amount for cash: the change). */
  tenderedCents: number
  createdAt: string
  userId: string
}

export interface OrderTotalsDto {
  grossCents: number
  /** Line discounts and free lines. */
  lineDiscountsCents: number
  ticketDiscountCents: number
  totalCents: number
  vat: VatRow[]
}

export interface OrderDto {
  id: string
  dayId: string
  type: OrderType
  tableId: string | null
  tableLabel: string | null
  covers: number
  /** Café / snack counter number, 1-999. */
  orderNumber: number | null
  status: OrderStatus
  userId: string
  customerId: string | null
  openedAt: string
  updatedAt: string
  note: string
  discount: DiscountDto | null
  /** A manager's percentage approval of a 'pct' ticket discount (bp); 0 without one. */
  approvedTicketBp: number
  /** A manager's budget (centimes) for amount discounts and line discounts; 0 without one. */
  approvedCents: number
  /** Every line, void ones included, by `seq`. */
  lines: OrderLineDto[]
  payments: PaymentDto[]
  totals: OrderTotalsDto
  paidCents: number
  dueCents: number
  changeCents: number
}
