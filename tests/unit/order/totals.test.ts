import { describe, expect, it } from 'vitest'
import type { Discount } from '../../../src/main/domain/order/discount'
import { lineNet } from '../../../src/main/domain/order/line'
import { activeLines } from '../../../src/main/domain/order/order'
import { computeTotals } from '../../../src/main/domain/order/totals'
import { errorCodeOf, makeLine, randomOrder, seededRandom } from '../../helpers/order'

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)

/** 2 x Tajine 70,00 + 1 x Couscous 95,00 ("sans oignons", no extra charge) + 3 x Thé 12,00 = 271,00 DH, all at 10 %. */
function restaurantTicket() {
  return [
    makeLine({ id: 'tajine', qtyMilli: 2000, unitPriceCents: 7000 }),
    makeLine({
      id: 'couscous',
      unitPriceCents: 9500,
      modifiers: [{ id: 'oignons', name: { fr: 'sans oignons' }, priceDeltaCents: 0 }]
    }),
    makeLine({ id: 'the', qtyMilli: 3000, unitPriceCents: 1200 })
  ]
}

describe('computeTotals', () => {
  it('totals a ticket and splits its 10 % VAT once', () => {
    const totals = computeTotals(restaurantTicket(), null)
    expect(totals.total).toBe(27100)
    expect(totals.gross).toBe(27100)
    expect(totals.lineDiscounts).toBe(0)
    expect(totals.ticketDiscount).toBe(0)
    expect(totals.perLine).toEqual([
      { lineId: 'tajine', net: 14000 },
      { lineId: 'couscous', net: 9500 },
      { lineId: 'the', net: 3600 }
    ])
    expect(totals.vat).toEqual([{ rateBp: 1000, ttc: 27100, ht: 24636, vat: 2464 }])
  })

  it('spreads a 10 % ticket discount over the lines, which still add up to the total', () => {
    const totals = computeTotals(restaurantTicket(), { kind: 'pct', bp: 1000, reason: 'client fidèle' })
    expect(totals.ticketDiscount).toBe(2710)
    expect(totals.total).toBe(24390)
    expect(totals.perLine).toEqual([
      { lineId: 'tajine', net: 12600 },
      { lineId: 'couscous', net: 8550 },
      { lineId: 'the', net: 3240 }
    ])
    expect(sum(totals.perLine.map((l) => l.net))).toBe(24390)
    expect(totals.vat).toEqual([{ rateBp: 1000, ttc: 24390, ht: 22173, vat: 2217 }])
  })

  it('spreads a fixed ticket discount with the largest remainder, to the centime', () => {
    const lines = [makeLine({ id: 'a', unitPriceCents: 1000 }), makeLine({ id: 'b', unitPriceCents: 1000 }), makeLine({ id: 'c', unitPriceCents: 1000 })]
    const totals = computeTotals(lines, { kind: 'amount', cents: 100, reason: 'geste' })
    expect(totals.ticketDiscount).toBe(100)
    expect(totals.total).toBe(2900)
    expect(totals.perLine).toEqual([
      { lineId: 'a', net: 966 },
      { lineId: 'b', net: 967 },
      { lineId: 'c', net: 967 }
    ])
  })

  it('caps a fixed ticket discount at what is left to pay', () => {
    const totals = computeTotals(restaurantTicket(), { kind: 'amount', cents: 99999, reason: 'x' })
    expect(totals.ticketDiscount).toBe(27100)
    expect(totals.total).toBe(0)
    expect(totals.perLine.map((l) => l.net)).toEqual([0, 0, 0])
    expect(totals.vat).toEqual([])
  })

  it('applies the ticket discount to what the line discounts left, not to the gross', () => {
    const lines = [
      makeLine({ id: 'a', unitPriceCents: 10000, discount: { kind: 'pct', bp: 5000, reason: 'x' } }),
      makeLine({ id: 'b', unitPriceCents: 5000 })
    ]
    const totals = computeTotals(lines, { kind: 'pct', bp: 1000, reason: 'y' })
    expect(totals.gross).toBe(15000)
    expect(totals.lineDiscounts).toBe(5000)
    expect(totals.ticketDiscount).toBe(1000) // 10 % of 10000
    expect(totals.total).toBe(9000)
    expect(totals.gross - totals.lineDiscounts - totals.ticketDiscount).toBe(totals.total)
  })

  it('leaves a free line out of the total, and counts its value as given away', () => {
    const lines = [...restaurantTicket(), makeLine({ id: 'offert', unitPriceCents: 4000, vatBp: 700, free: true })]
    const totals = computeTotals(lines, null)
    expect(totals.total).toBe(27100)
    expect(totals.gross).toBe(31100)
    expect(totals.lineDiscounts).toBe(4000)
    expect(totals.perLine).toContainEqual({ lineId: 'offert', net: 0 })
    // No empty 7 % row for the free line.
    expect(totals.vat).toEqual([{ rateBp: 1000, ttc: 27100, ht: 24636, vat: 2464 }])
  })

  it('ignores the discount of a free line, and gives the ticket discount nothing to take off it', () => {
    const lines = [
      makeLine({ id: 'paid', unitPriceCents: 2000 }),
      makeLine({ id: 'offert', unitPriceCents: 3000, free: true, discount: { kind: 'amount', cents: 500, reason: 'x' } })
    ]
    const totals = computeTotals(lines, { kind: 'pct', bp: 5000, reason: 'y' })
    expect(totals.lineDiscounts).toBe(3000)
    expect(totals.ticketDiscount).toBe(1000)
    expect(totals.total).toBe(1000)
    expect(totals.perLine).toEqual([
      { lineId: 'paid', net: 1000 },
      { lineId: 'offert', net: 0 }
    ])
  })

  it('does not count a void line, nor list it', () => {
    const lines = [...restaurantTicket(), makeLine({ id: 'annule', unitPriceCents: 9999, status: 'void' })]
    const totals = computeTotals(lines, null)
    expect(totals.total).toBe(27100)
    expect(totals.perLine.map((l) => l.lineId)).toEqual(['tajine', 'couscous', 'the'])
  })

  it('does not look at a void line at all (its quantity may be anything)', () => {
    const totals = computeTotals([makeLine({ id: 'ok', unitPriceCents: 500 }), makeLine({ status: 'void', qtyMilli: 0 })], null)
    expect(totals.total).toBe(500)
  })

  it('splits VAT per rate, highest first, from the final nets', () => {
    const lines = [
      makeLine({ id: 'a', unitPriceCents: 12000, vatBp: 2000 }),
      makeLine({ id: 'b', unitPriceCents: 7000, vatBp: 1000 }),
      makeLine({ id: 'c', qtyMilli: 3000, unitPriceCents: 1200, vatBp: 1000 }),
      makeLine({ id: 'd', unitPriceCents: 800, vatBp: 0 })
    ]
    const totals = computeTotals(lines, null)
    expect(totals.total).toBe(23400)
    expect(totals.vat).toEqual([
      { rateBp: 2000, ttc: 12000, ht: 10000, vat: 2000 },
      { rateBp: 1000, ttc: 10600, ht: 9636, vat: 964 },
      { rateBp: 0, ttc: 800, ht: 800, vat: 0 }
    ])
  })

  it('weighs a product sold by weight', () => {
    const totals = computeTotals([makeLine({ qtyMilli: 350, unitPriceCents: 6000, vatBp: 700 })], null)
    expect(totals.total).toBe(2100)
    expect(totals.vat).toEqual([{ rateBp: 700, ttc: 2100, ht: 1963, vat: 137 }])
  })

  it('is zero for an empty ticket, and for one with only void or free lines', () => {
    const empty = { gross: 0, lineDiscounts: 0, ticketDiscount: 0, total: 0, perLine: [], vat: [] }
    expect(computeTotals([], null)).toEqual(empty)
    expect(computeTotals([], { kind: 'pct', bp: 1000, reason: 'x' })).toEqual(empty)
    expect(computeTotals([makeLine({ status: 'void' })], null)).toEqual(empty)
    const onlyFree = computeTotals([makeLine({ id: 'f', free: true })], { kind: 'amount', cents: 500, reason: 'x' })
    expect(onlyFree).toMatchObject({ gross: 1000, lineDiscounts: 1000, ticketDiscount: 0, total: 0, vat: [] })
  })

  it('does not change its input', () => {
    const lines = restaurantTicket()
    const copy = structuredClone(lines)
    computeTotals(lines, { kind: 'pct', bp: 1000, reason: 'x' })
    expect(lines).toEqual(copy)
  })

  it('refuses what cannot be priced, with a domain error', () => {
    const bad = (over: Parameters<typeof makeLine>[0]) => () => computeTotals([makeLine(over)], null)
    expect(errorCodeOf(bad({ qtyMilli: 0 }))).toBe('invalid_qty')
    expect(errorCodeOf(bad({ qtyMilli: -1000 }))).toBe('invalid_qty')
    expect(errorCodeOf(bad({ unitPriceCents: -1 }))).toBe('invalid_price')
    expect(errorCodeOf(bad({ vatBp: -1 }))).toBe('invalid_vat')
    expect(errorCodeOf(bad({ vatBp: 10.5 }))).toBe('invalid_vat')
    const ticket = (discount: Discount) => () => computeTotals([makeLine()], discount)
    expect(errorCodeOf(ticket({ kind: 'pct', bp: 10001, reason: 'x' }))).toBe('invalid_discount')
    expect(errorCodeOf(ticket({ kind: 'amount', cents: -1, reason: 'x' }))).toBe('invalid_discount')
  })

  it('sums exactly over 200 random orders (mixed rates, discounts, free and void lines)', () => {
    const random = seededRandom(20261022)
    let withTicketDiscount = 0
    let withFree = 0
    let withVoid = 0
    for (let i = 0; i < 200; i += 1) {
      const { lines, ticketDiscount } = randomOrder(random)
      const totals = computeTotals(lines, ticketDiscount)
      const active = activeLines(lines)

      expect(sum(totals.perLine.map((l) => l.net))).toBe(totals.total)
      expect(sum(totals.vat.map((row) => row.ttc))).toBe(totals.total)
      expect(totals.gross - totals.lineDiscounts - totals.ticketDiscount).toBe(totals.total)
      expect(totals.perLine.map((l) => l.lineId)).toEqual(active.map((l) => l.id))
      for (const { net } of totals.perLine) expect(net).toBeGreaterThanOrEqual(0)
      for (const row of totals.vat) {
        expect(row.ht + row.vat).toBe(row.ttc)
        expect(row.ttc).toBeGreaterThan(0)
      }
      expect(totals.vat.map((row) => row.rateBp)).toEqual([...new Set(totals.vat.map((row) => row.rateBp))].sort((a, b) => b - a))

      // The ticket discount is what the rule says, taken from what the line discounts left.
      const base = sum(active.map(lineNet))
      let expected = 0
      if (ticketDiscount?.kind === 'pct') expected = Math.min(base, Math.round((base * ticketDiscount.bp) / 10000))
      if (ticketDiscount?.kind === 'amount') expected = Math.min(base, ticketDiscount.cents)
      expect(totals.ticketDiscount).toBe(expected)
      expect(totals.total).toBe(base - expected)
      for (const line of active.filter((l) => l.free)) {
        expect(totals.perLine.find((l) => l.lineId === line.id)?.net).toBe(0)
      }

      if (ticketDiscount) withTicketDiscount += 1
      if (lines.some((l) => l.free)) withFree += 1
      if (lines.some((l) => l.status === 'void')) withVoid += 1
    }
    // The generator really exercises each case.
    expect(withTicketDiscount).toBeGreaterThan(50)
    expect(withFree).toBeGreaterThan(30)
    expect(withVoid).toBeGreaterThan(30)
  })
})
