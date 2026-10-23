import type { LineModifierDto, PaymentDto } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { Discount } from '../../../domain/order/discount'
import type { OrderStatus, OrderType } from '../../../domain/order/order'
import type { StoredLine } from './orders-repo'

// The rows of `orders`, `order_lines` and `payments`, and their mapping to what the use cases work on.

export interface OrderRow {
  id: string
  day_id: string
  type: OrderType
  table_id: string | null
  covers: number
  order_number: number | null
  status: OrderStatus
  user_id: string
  customer_id: string | null
  opened_at: string
  updated_at: string
  note: string
  discount_kind: 'pct' | 'amount' | null
  discount_value: number
  discount_reason: string
  approved_ticket_bp: number
  approved_cents: number
  table_label: string | null
}

export interface LineRow {
  id: string
  order_id: string
  seq: number
  product_id: string
  name_json: string
  qty_milli: number
  unit_price_cents: number
  vat_bp: number
  modifiers_json: string
  note: string
  course: number
  status: 'active' | 'void'
  void_reason: string
  sent_at: string | null
  discount_kind: 'pct' | 'amount' | null
  discount_value: number
  discount_reason: string
  free: number
  free_reason: string
  user_id: string
  created_at: string
}

export interface PaymentRow {
  id: string
  method_code: string
  amount_cents: number
  tendered_cents: number
  created_at: string
  user_id: string
}

export const toDiscount = (kind: 'pct' | 'amount' | null, value: number, reason: string): Discount | null =>
  kind === null ? null : kind === 'pct' ? { kind, bp: value, reason } : { kind, cents: value, reason }

export const discountColumns = (d: Discount | null): [string | null, number, string] =>
  d === null ? [null, 0, ''] : [d.kind, d.kind === 'pct' ? d.bp : d.cents, d.reason]

export const toLine = (row: LineRow): StoredLine => ({
  id: row.id,
  seq: row.seq,
  productId: row.product_id,
  name: JSON.parse(row.name_json) as LocalizedName,
  qtyMilli: row.qty_milli,
  unitPriceCents: row.unit_price_cents,
  vatBp: row.vat_bp,
  modifiers: JSON.parse(row.modifiers_json) as LineModifierDto[],
  note: row.note,
  course: row.course,
  status: row.status,
  voidReason: row.void_reason,
  sentAt: row.sent_at,
  discount: toDiscount(row.discount_kind, row.discount_value, row.discount_reason),
  free: row.free === 1,
  freeReason: row.free_reason,
  userId: row.user_id,
  createdAt: row.created_at
})

export const toPayment = (row: PaymentRow): PaymentDto => ({
  id: row.id,
  methodCode: row.method_code,
  amountCents: row.amount_cents,
  tenderedCents: row.tendered_cents,
  createdAt: row.created_at,
  userId: row.user_id
})
