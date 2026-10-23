import { describe, expect, it } from 'vitest'
import { lineGross, lineNet } from '../../../src/main/domain/order/line'
import { errorCodeOf, makeLine } from '../../helpers/order'

describe('lineGross', () => {
  it('multiplies the unit price by the quantity', () => {
    expect(lineGross(makeLine({ qtyMilli: 2000, unitPriceCents: 7000 }))).toBe(14000)
  })

  it('adds the modifiers to the unit price first', () => {
    const line = makeLine({
      qtyMilli: 2000,
      unitPriceCents: 9500,
      modifiers: [
        { id: 'a', name: { fr: 'sans oignons' }, priceDeltaCents: 0 },
        { id: 'b', name: { fr: 'fromage' }, priceDeltaCents: 300 }
      ]
    })
    expect(lineGross(line)).toBe(19600)
  })

  it('takes a negative modifier off the unit price', () => {
    const line = makeLine({ unitPriceCents: 1000, modifiers: [{ id: 'a', name: { fr: 'sans fromage' }, priceDeltaCents: -200 }] })
    expect(lineGross(line)).toBe(800)
  })

  it('prices by weight: 350 g at 60,00 DH/kg is 21,00 DH', () => {
    expect(lineGross(makeLine({ qtyMilli: 350, unitPriceCents: 6000 }))).toBe(2100)
  })

  it('rounds half up to the centime', () => {
    expect(lineGross(makeLine({ qtyMilli: 500, unitPriceCents: 1001 }))).toBe(501) // 500,5
    expect(lineGross(makeLine({ qtyMilli: 1, unitPriceCents: 1500 }))).toBe(2) // 1,5
    expect(lineGross(makeLine({ qtyMilli: 333, unitPriceCents: 1999 }))).toBe(666) // 665,667
    expect(lineGross(makeLine({ qtyMilli: 333, unitPriceCents: 1000 }))).toBe(333)
  })

  it('refuses a quantity that is zero, negative, fractional or not a number (credit notes negate a computed snapshot instead)', () => {
    for (const qtyMilli of [0, -1000, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorCodeOf(() => lineGross(makeLine({ qtyMilli })))).toBe('invalid_qty')
    }
  })

  it('refuses a unit price that is negative once the modifiers are in, or that is not an integer', () => {
    const cheap = makeLine({ unitPriceCents: 100, modifiers: [{ id: 'a', name: { fr: 'x' }, priceDeltaCents: -101 }] })
    expect(errorCodeOf(() => lineGross(cheap))).toBe('invalid_price')
    expect(errorCodeOf(() => lineGross(makeLine({ unitPriceCents: 10.5 })))).toBe('invalid_price')
    expect(errorCodeOf(() => lineGross(makeLine({ unitPriceCents: -1 })))).toBe('invalid_price')
  })

  it('refuses a product that no longer fits a safe integer', () => {
    expect(errorCodeOf(() => lineGross(makeLine({ unitPriceCents: 2 ** 40, qtyMilli: 2 ** 20 })))).toBe('invalid_price')
  })
})

describe('lineNet', () => {
  it('is the gross when there is no discount', () => {
    expect(lineNet(makeLine({ qtyMilli: 3000, unitPriceCents: 1200 }))).toBe(3600)
  })

  it('takes a percentage off, rounded half up to the centime', () => {
    const pct = (bp: number) => ({ kind: 'pct' as const, bp, reason: 'fidélité' })
    expect(lineNet(makeLine({ unitPriceCents: 3333, discount: pct(500) }))).toBe(3166) // 166,65 -> 167
    expect(lineNet(makeLine({ unitPriceCents: 10, discount: pct(500) }))).toBe(9) // 0,5 -> 1
    expect(lineNet(makeLine({ unitPriceCents: 1005, discount: pct(1000) }))).toBe(904) // 100,5 -> 101
    expect(lineNet(makeLine({ unitPriceCents: 1000, discount: pct(10000) }))).toBe(0)
  })

  it('takes a fixed amount off, never below zero', () => {
    const amount = (cents: number) => ({ kind: 'amount' as const, cents, reason: 'geste' })
    expect(lineNet(makeLine({ unitPriceCents: 1200, discount: amount(200) }))).toBe(1000)
    expect(lineNet(makeLine({ unitPriceCents: 1200, discount: amount(5000) }))).toBe(0)
  })

  it('is zero for a free line, whatever its discount says', () => {
    expect(lineNet(makeLine({ free: true }))).toBe(0)
    expect(lineNet(makeLine({ free: true, discount: { kind: 'pct', bp: 5000, reason: 'x' } }))).toBe(0)
  })

  it('still refuses a bad quantity on a free line', () => {
    expect(errorCodeOf(() => lineNet(makeLine({ free: true, qtyMilli: 0 })))).toBe('invalid_qty')
  })

  it('refuses a discount that is not a whole number within range', () => {
    expect(errorCodeOf(() => lineNet(makeLine({ discount: { kind: 'pct', bp: -1, reason: 'x' } })))).toBe('invalid_discount')
    expect(errorCodeOf(() => lineNet(makeLine({ discount: { kind: 'pct', bp: 10001, reason: 'x' } })))).toBe('invalid_discount')
    expect(errorCodeOf(() => lineNet(makeLine({ discount: { kind: 'pct', bp: 12.5, reason: 'x' } })))).toBe('invalid_discount')
    expect(errorCodeOf(() => lineNet(makeLine({ discount: { kind: 'amount', cents: -5, reason: 'x' } })))).toBe('invalid_discount')
    expect(errorCodeOf(() => lineNet(makeLine({ discount: { kind: 'amount', cents: 0.5, reason: 'x' } })))).toBe('invalid_discount')
  })
})
