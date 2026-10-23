import { allocateProportional, vatBreakdown, type VatRow } from '@shared/vat'
import { AppErrorException } from '../../application/errors'
import { assertDiscount, discountCents, type Discount } from './discount'
import { lineGross, lineNet, type OrderLine } from './line'
import { activeLines } from './order'

/**
 * What a ticket comes to, in centimes. Only active lines count. A free line is a line discount of its
 * whole gross, so `gross - lineDiscounts - ticketDiscount === total` always, and `perLine` (every active
 * line, free ones at 0) adds up to `total`. `vat` is split per rate from the final per-line nets, rates
 * with nothing to pay left out.
 */
export interface Totals {
  gross: number
  lineDiscounts: number
  ticketDiscount: number
  total: number
  perLine: { lineId: string; net: number }[]
  vat: VatRow[]
}

/** One active line, priced: `net = gross - lineDiscount - ticketDiscount`. */
export interface LinePricing {
  lineId: string
  vatBp: number
  gross: number
  lineDiscount: number
  /** The line's share of the ticket discount. */
  ticketDiscount: number
  net: number
}

/**
 * Prices every active line. The ticket discount (capped at the sum of the nets) is spread over the nets
 * left by the line discounts with `allocateProportional`, so the final nets add up to the total exactly.
 */
export function priceLines(lines: OrderLine[], ticketDiscount: Discount | null): LinePricing[] {
  if (ticketDiscount) assertDiscount(ticketDiscount)
  const active = activeLines(lines)
  for (const line of active) {
    if (!Number.isSafeInteger(line.vatBp) || line.vatBp < 0) {
      throw new AppErrorException('invalid_vat', { lineId: line.id, vatBp: line.vatBp })
    }
  }
  const gross = active.map(lineGross)
  const nets = active.map(lineNet)
  const base = nets.reduce((sum, n) => sum + n, 0)
  const shares = allocateProportional(ticketDiscount ? discountCents(base, ticketDiscount) : 0, nets)
  return active.map((line, i) => ({
    lineId: line.id,
    vatBp: line.vatBp,
    gross: gross[i],
    lineDiscount: gross[i] - nets[i],
    ticketDiscount: shares[i],
    net: nets[i] - shares[i]
  }))
}

/** The totals of some priced lines (all of a ticket, or one group of a split). */
export function totalsOf(priced: LinePricing[]): Totals {
  const sum = (pick: (p: LinePricing) => number): number => priced.reduce((acc, p) => acc + pick(p), 0)
  return {
    gross: sum((p) => p.gross),
    lineDiscounts: sum((p) => p.lineDiscount),
    ticketDiscount: sum((p) => p.ticketDiscount),
    total: sum((p) => p.net),
    perLine: priced.map((p) => ({ lineId: p.lineId, net: p.net })),
    vat: vatBreakdown(priced.filter((p) => p.net > 0).map((p) => ({ ttc: p.net, rateBp: p.vatBp })))
  }
}

export function computeTotals(lines: OrderLine[], ticketDiscount: Discount | null): Totals {
  return totalsOf(priceLines(lines, ticketDiscount))
}
