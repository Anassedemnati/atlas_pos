import { equalShares } from '@shared/split'
import { AppErrorException } from '../../application/errors'
import type { Discount } from './discount'
import type { OrderLine } from './line'
import { priceLines, totalsOf, type LinePricing, type Totals } from './totals'

/**
 * The bill of each group of lines (ids of active lines), for a split by items. The whole ticket is priced
 * once, ticket discount included, and a group takes its lines' final nets, so the figures of the groups add
 * up to the ticket's when the groups cover all its active lines (VAT: per group, the TTC adds up, the HT may
 * differ by a centime). Throws `invalid_split` for an empty group, a line listed twice or one that is not an
 * active line of the ticket: any of them would bill a line twice or not at all.
 */
export function splitByItems(lines: OrderLine[], groups: string[][], ticketDiscount: Discount | null): Totals[] {
  const priced = new Map<string, LinePricing>(priceLines(lines, ticketDiscount).map((p) => [p.lineId, p]))
  const taken = new Set<string>()
  return groups.map((ids) => {
    if (ids.length === 0) throw new AppErrorException('invalid_split', { reason: 'empty_group' })
    const group = ids.map((lineId) => {
      const line = priced.get(lineId)
      if (!line) throw new AppErrorException('invalid_split', { reason: 'unknown_line', lineId })
      if (taken.has(lineId)) throw new AppErrorException('invalid_split', { reason: 'duplicate_line', lineId })
      taken.add(lineId)
      return line
    })
    return totalsOf(group)
  })
}

/** `totalCents` in `parts` equal shares, the odd centimes going to the first shares; adds up to the total. */
export function splitEqual(totalCents: number, parts: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new AppErrorException('invalid_amount', { totalCents })
  if (!Number.isSafeInteger(parts) || parts < 1) throw new AppErrorException('invalid_parts', { parts })
  return equalShares(totalCents, parts)
}
