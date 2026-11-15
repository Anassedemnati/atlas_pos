import type { DayDto, TicketDto, ZData } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { VatRow } from '@shared/vat'
import { lineGross, type OrderLine } from '../../../domain/order/line'

export interface ZInput {
  day: DayDto
  /** null for an X report. */
  zNumber: number | null
  closedAt: string | null
  /** The sale tickets and credit notes of the day. */
  tickets: TicketDto[]
  /** The lines voided on the orders of the day. */
  voids: OrderLine[]
  reprints: number
}

/** A running total per key, kept in the order keys are first seen. */
function tally<T>(make: () => T): { get(key: string): T; values(): T[] } {
  const map = new Map<string, T>()
  return {
    get(key) {
      let entry = map.get(key)
      if (!entry) {
        entry = make()
        map.set(key, entry)
      }
      return entry
    },
    values: () => [...map.values()]
  }
}

/**
 * The X / Z figures of a business day, from the ticket snapshots only (what was printed, not the live
 * rows). Credit notes carry negated amounts, so they simply add up; their counts (lines, quantities,
 * payments) are subtracted. A free line is in the gross and in `freeItems`, not in `discountsCents`.
 */
export function computeZData(input: ZInput): ZData {
  let ticketsCount = 0
  let creditsCount = 0
  let grossCents = 0
  let discountsCents = 0
  let totalCents = 0
  const free = { count: 0, cents: 0 }
  const payments = tally(() => ({ methodCode: '', name: { fr: '' } as LocalizedName, count: 0, cents: 0 }))
  const vat = tally<VatRow>(() => ({ rateBp: 0, ttc: 0, ht: 0, vat: 0 }))
  const categories = tally(() => ({ categoryId: null as string | null, name: null as LocalizedName | null, qtyMilli: 0, cents: 0 }))
  const users = tally(() => ({ userId: '', displayName: '', ticketsCount: 0, cents: 0 }))

  for (const ticket of input.tickets) {
    const s = ticket.snapshot
    const sign = ticket.kind === 'credit' ? -1 : 1
    if (ticket.kind === 'sale') ticketsCount += 1
    else creditsCount += 1
    grossCents += s.totals.grossCents
    discountsCents += s.totals.lineDiscountsCents + s.totals.ticketDiscountCents
    totalCents += s.totals.totalCents

    for (const p of s.payments) {
      const entry = payments.get(p.methodCode)
      entry.methodCode = p.methodCode
      entry.name = p.methodName
      entry.count += sign
      entry.cents += p.amountCents
    }
    for (const row of s.vat) {
      const entry = vat.get(String(row.rateBp))
      entry.rateBp = row.rateBp
      entry.ttc += row.ttc
      entry.ht += row.ht
      entry.vat += row.vat
    }
    for (const line of s.lines) {
      const entry = categories.get(line.categoryId ?? '')
      entry.categoryId = line.categoryId
      entry.name = line.categoryName
      entry.qtyMilli += sign * line.qtyMilli
      entry.cents += line.netCents
      if (line.free) {
        free.count += sign
        free.cents += line.grossCents
      }
    }
    const user = users.get(s.user.id)
    user.userId = s.user.id
    user.displayName = s.user.displayName
    if (ticket.kind === 'sale') user.ticketsCount += 1
    user.cents += s.totals.totalCents
  }

  return {
    dayNumber: input.day.number,
    zNumber: input.zNumber,
    openedAt: input.day.openedAt,
    closedAt: input.closedAt,
    ticketsCount,
    creditsCount,
    grossCents,
    // A free line is a line discount of its whole gross in the ticket totals; it is reported apart.
    discountsCents: discountsCents - free.cents,
    totalCents,
    byPayment: payments.values().sort((a, b) => (a.methodCode < b.methodCode ? -1 : a.methodCode > b.methodCode ? 1 : 0)),
    byVat: vat.values().sort((a, b) => b.rateBp - a.rateBp),
    byCategory: categories.values(),
    byUser: users.values(),
    voids: { count: input.voids.length, cents: input.voids.reduce((sum, line) => sum + lineGross(line), 0) },
    freeItems: free,
    reprints: input.reprints
  }
}
