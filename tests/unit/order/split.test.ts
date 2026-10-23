import { describe, expect, it } from 'vitest'
import { activeLines } from '../../../src/main/domain/order/order'
import { splitByItems, splitEqual } from '../../../src/main/domain/order/split'
import { computeTotals } from '../../../src/main/domain/order/totals'
import { errorCodeOf, makeLine, randomOrder, seededRandom } from '../../helpers/order'

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)

describe('splitEqual', () => {
  it('shares a total in equal parts, the odd centimes going to the first parts', () => {
    expect(splitEqual(27100, 3)).toEqual([9034, 9033, 9033])
    expect(splitEqual(10000, 3)).toEqual([3334, 3333, 3333])
    expect(splitEqual(5, 3)).toEqual([2, 2, 1])
    expect(splitEqual(27100, 2)).toEqual([13550, 13550])
  })

  it('gives the whole total to a single part, and zeros for a zero total', () => {
    expect(splitEqual(27100, 1)).toEqual([27100])
    expect(splitEqual(0, 4)).toEqual([0, 0, 0, 0])
  })

  it('always adds up to the total', () => {
    for (const total of [1, 99, 27100, 99999999]) {
      for (const parts of [1, 2, 3, 7, 12]) {
        expect(sum(splitEqual(total, parts))).toBe(total)
      }
    }
  })

  it('refuses a number of parts below 1 or not whole, and a total that is not whole centimes', () => {
    expect(errorCodeOf(() => splitEqual(27100, 0))).toBe('invalid_parts')
    expect(errorCodeOf(() => splitEqual(27100, -2))).toBe('invalid_parts')
    expect(errorCodeOf(() => splitEqual(27100, 2.5))).toBe('invalid_parts')
    expect(errorCodeOf(() => splitEqual(27100.5, 2))).toBe('invalid_amount')
    expect(errorCodeOf(() => splitEqual(-1, 2))).toBe('invalid_amount')
  })
})

describe('splitByItems', () => {
  const lines = [
    makeLine({ id: 'tajine', qtyMilli: 2000, unitPriceCents: 7000 }),
    makeLine({ id: 'couscous', unitPriceCents: 9500 }),
    makeLine({ id: 'the', qtyMilli: 3000, unitPriceCents: 1200, vatBp: 2000 })
  ]

  it('prices each group on its own lines', () => {
    const [first, second] = splitByItems(lines, [['tajine'], ['couscous', 'the']], null)
    expect(first).toEqual(computeTotals([lines[0]], null))
    expect(first.total).toBe(14000)
    expect(second.total).toBe(13100)
    expect(second.perLine).toEqual([
      { lineId: 'couscous', net: 9500 },
      { lineId: 'the', net: 3600 }
    ])
    expect(second.vat).toEqual([
      { rateBp: 2000, ttc: 3600, ht: 3000, vat: 600 },
      { rateBp: 1000, ttc: 9500, ht: 8636, vat: 864 }
    ])
  })

  it('keeps the ticket discount: every group carries its share, and the groups add up to the ticket', () => {
    const discount = { kind: 'amount' as const, cents: 1000, reason: 'geste' }
    const whole = computeTotals(lines, discount)
    const groups = splitByItems(lines, [['tajine'], ['couscous'], ['the']], discount)
    expect(sum(groups.map((g) => g.total))).toBe(whole.total)
    expect(sum(groups.map((g) => g.ticketDiscount))).toBe(1000)
    expect(groups.flatMap((g) => g.perLine)).toEqual(whole.perLine)
  })

  it('takes a percentage ticket discount once, not once per group', () => {
    const discount = { kind: 'pct' as const, bp: 1000, reason: 'fidélité' }
    const groups = splitByItems(lines, [['tajine', 'the'], ['couscous']], discount)
    expect(sum(groups.map((g) => g.total))).toBe(computeTotals(lines, discount).total)
  })

  it('may pay only some of the lines, the others staying on the ticket', () => {
    const [only] = splitByItems(lines, [['the']], null)
    expect(only.total).toBe(3600)
  })

  it('refuses a line in two groups, an unknown or void line, and an empty group', () => {
    expect(errorCodeOf(() => splitByItems(lines, [['tajine'], ['tajine', 'the']], null))).toBe('invalid_split')
    expect(errorCodeOf(() => splitByItems(lines, [['tajine', 'tajine']], null))).toBe('invalid_split')
    expect(errorCodeOf(() => splitByItems(lines, [['nope']], null))).toBe('invalid_split')
    expect(errorCodeOf(() => splitByItems(lines, [[]], null))).toBe('invalid_split')
    const withVoid = [...lines, makeLine({ id: 'annule', status: 'void' })]
    expect(errorCodeOf(() => splitByItems(withVoid, [['annule']], null))).toBe('invalid_split')
  })

  it('returns nothing for no groups', () => {
    expect(splitByItems(lines, [], null)).toEqual([])
  })

  it('adds up to the full ticket over 200 random orders and random groupings', () => {
    const random = seededRandom(20261023)
    let checked = 0
    for (let i = 0; i < 200; i += 1) {
      const { lines: orderLines, ticketDiscount } = randomOrder(random)
      const active = activeLines(orderLines)
      if (active.length === 0) continue
      const whole = computeTotals(orderLines, ticketDiscount)

      // Deal the active lines into 1..3 groups at random; drop the groups that stay empty.
      const buckets: string[][] = [[], [], []]
      for (const line of active) buckets[Math.floor(random() * 3)].push(line.id)
      const groups = buckets.filter((ids) => ids.length > 0)
      const parts = splitByItems(orderLines, groups, ticketDiscount)

      expect(parts).toHaveLength(groups.length)
      for (const field of ['gross', 'lineDiscounts', 'ticketDiscount', 'total'] as const) {
        expect(sum(parts.map((p) => p[field]))).toBe(whole[field])
      }
      for (const part of parts) {
        expect(sum(part.perLine.map((l) => l.net))).toBe(part.total)
        expect(sum(part.vat.map((row) => row.ttc))).toBe(part.total)
        expect(part.gross - part.lineDiscounts - part.ticketDiscount).toBe(part.total)
      }
      const wholeNets = new Map(whole.perLine.map((l) => [l.lineId, l.net]))
      for (const { lineId, net } of parts.flatMap((p) => p.perLine)) expect(net).toBe(wholeNets.get(lineId))
      checked += 1
    }
    expect(checked).toBeGreaterThan(150)
  })
})
