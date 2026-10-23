import type { BusinessLegalDto, CustomerDto, TicketLineSnapshot, TicketSnapshot } from '@shared/dto'
import type { Lang, LocalizedName } from '@shared/names'
import { activeLines } from '../../../domain/order/order'
import { priceLines, totalsOf } from '../../../domain/order/totals'
import type { StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import { paymentTotals } from '../orders/context'

/** Sale tickets: `000001`. Credit notes: `AV-000001`. */
export const ticketLabel = (kind: 'sale' | 'credit', number: number): string =>
  `${kind === 'credit' ? 'AV-' : ''}${String(number).padStart(6, '0')}`

export interface SnapshotHeader {
  number: number
  label: string
  closedAt: string
  dayNumber: number
  business: BusinessLegalDto
  receipt: { lang: Lang; header: string; footer: string }
  user: { id: string; displayName: string }
}

export interface SaleSnapshotInput extends SnapshotHeader {
  order: StoredOrder
  table: { id: string; label: string } | null
  customer: CustomerDto | undefined
  categoryOf(productId: string): { id: string; name: LocalizedName } | undefined
  methodName(code: string): LocalizedName
}

/** Everything the sale ticket prints, priced once here: the reprint and the Z report read only this. */
export function saleSnapshot(input: SaleSnapshotInput): TicketSnapshot {
  const { order } = input
  const priced = priceLines(order.lines, order.discount)
  const totals = totalsOf(priced)
  const lines: TicketLineSnapshot[] = activeLines(order.lines).map((line, i) => {
    const price = priced[i]!
    const category = input.categoryOf(line.productId)
    return {
      id: line.id,
      productId: line.productId,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      name: line.name,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      modifiers: line.modifiers,
      note: line.note,
      vatBp: line.vatBp,
      discount: line.discount,
      free: line.free,
      freeReason: line.freeReason,
      grossCents: price.gross,
      lineDiscountCents: price.lineDiscount,
      ticketDiscountCents: price.ticketDiscount,
      netCents: price.net
    }
  })
  const { paid, change } = paymentTotals(totals.total, order.payments)
  const customer = input.customer
  return {
    version: 1,
    kind: 'sale',
    number: input.number,
    label: input.label,
    closedAt: input.closedAt,
    dayNumber: input.dayNumber,
    business: input.business,
    receipt: input.receipt,
    order: {
      id: order.id,
      type: order.type,
      number: order.orderNumber,
      table: input.table,
      covers: order.covers,
      note: order.note
    },
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          companyName: customer.companyName,
          ice: customer.ice,
          isCompany: customer.isCompany
        }
      : null,
    user: input.user,
    lines,
    ticketDiscount: order.discount,
    totals: {
      grossCents: totals.gross,
      lineDiscountsCents: totals.lineDiscounts,
      ticketDiscountCents: totals.ticketDiscount,
      totalCents: totals.total
    },
    vat: totals.vat,
    payments: order.payments.map((p) => ({
      methodCode: p.methodCode,
      methodName: input.methodName(p.methodCode),
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents
    })),
    paidCents: paid,
    changeCents: change
  }
}

const neg = (n: number): number => (n === 0 ? 0 : -n)

/**
 * The credit note of a sale: the sale's own figures (computed on positive values when it was closed),
 * negated, never recomputed from negative amounts. Quantities and unit prices stay as sold; the money is
 * refunded by the methods it was paid with, no change given. The header (number, day, issuer, business
 * identity) is the credit note's own.
 */
export function creditSnapshot(sale: TicketSnapshot, header: SnapshotHeader, ref: { ticketId: string; reason: string }): TicketSnapshot {
  return {
    ...sale,
    ...header,
    kind: 'credit',
    lines: sale.lines.map((line) => ({
      ...line,
      grossCents: neg(line.grossCents),
      lineDiscountCents: neg(line.lineDiscountCents),
      ticketDiscountCents: neg(line.ticketDiscountCents),
      netCents: neg(line.netCents)
    })),
    totals: {
      grossCents: neg(sale.totals.grossCents),
      lineDiscountsCents: neg(sale.totals.lineDiscountsCents),
      ticketDiscountCents: neg(sale.totals.ticketDiscountCents),
      totalCents: neg(sale.totals.totalCents)
    },
    vat: sale.vat.map((row) => ({ rateBp: row.rateBp, ttc: neg(row.ttc), ht: neg(row.ht), vat: neg(row.vat) })),
    payments: sale.payments.map((p) => ({ ...p, amountCents: neg(p.amountCents), tenderedCents: neg(p.amountCents) })),
    paidCents: neg(sale.paidCents),
    changeCents: 0,
    ref: { ticketId: ref.ticketId, label: sale.label, reason: ref.reason }
  }
}
