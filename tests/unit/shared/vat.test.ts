import { describe, expect, it } from 'vitest'
import { allocateProportional, splitTtc, vatBreakdown } from '@shared/vat'

describe('splitTtc', () => {
  it('splits a TTC amount into HT and VAT', () => {
    expect(splitTtc(7000, 1000)).toEqual({ ht: 6364, vat: 636 })
    expect(splitTtc(12000, 2000)).toEqual({ ht: 10000, vat: 2000 })
  })

  it('leaves 0 % VAT untouched', () => {
    expect(splitTtc(3800, 0)).toEqual({ ht: 3800, vat: 0 })
  })

  it('always satisfies ht + vat === ttc', () => {
    for (const rate of [2000, 1400, 1000, 700, 0]) {
      for (const ttc of [0, 1, 99, 100, 3333, 7000, 245000, 99999999]) {
        const { ht, vat } = splitTtc(ttc, rate)
        expect(ht + vat).toBe(ttc)
      }
    }
  })
})

describe('vatBreakdown', () => {
  it('groups by rate, splits each group once and sorts by rate descending', () => {
    expect(
      vatBreakdown([
        { ttc: 7000, rateBp: 1000 },
        { ttc: 3600, rateBp: 1000 },
        { ttc: 12000, rateBp: 2000 }
      ])
    ).toEqual([
      { rateBp: 2000, ttc: 12000, ht: 10000, vat: 2000 },
      { rateBp: 1000, ttc: 10600, ht: 9636, vat: 964 }
    ])
  })

  it('returns an empty array for no lines', () => {
    expect(vatBreakdown([])).toEqual([])
  })

  it('keeps a 0 % group, last', () => {
    expect(
      vatBreakdown([
        { ttc: 500, rateBp: 0 },
        { ttc: 600, rateBp: 2000 },
        { ttc: 700, rateBp: 700 }
      ])
    ).toEqual([
      { rateBp: 2000, ttc: 600, ht: 500, vat: 100 },
      { rateBp: 700, ttc: 700, ht: 654, vat: 46 },
      { rateBp: 0, ttc: 500, ht: 500, vat: 0 }
    ])
  })

  it('does not mutate its input', () => {
    const lines = [
      { ttc: 100, rateBp: 1000 },
      { ttc: 200, rateBp: 2000 }
    ]
    const copy = structuredClone(lines)
    vatBreakdown(lines)
    expect(lines).toEqual(copy)
  })
})

describe('allocateProportional', () => {
  it('uses the largest remainder method, lowest index first on ties', () => {
    const out = allocateProportional(1000, [1, 1, 1])
    expect(out).toEqual([334, 333, 333])
    expect(out.reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('gives the extra centime to the largest fractional remainder', () => {
    // exact shares: 1.4, 1.6 -> floors 1, 1 -> the leftover goes to the 1.6
    expect(allocateProportional(3, [7, 8])).toEqual([1, 2])
    expect(allocateProportional(100, [1, 2, 3])).toEqual([17, 33, 50])
  })

  it('allocates proportionally to the weights', () => {
    expect(allocateProportional(1000, [3000, 7000])).toEqual([300, 700])
    expect(allocateProportional(500, [0, 10, 0])).toEqual([0, 500, 0])
  })

  it('handles a zero total and a negative total', () => {
    expect(allocateProportional(0, [1, 2])).toEqual([0, 0])
    expect(allocateProportional(-1000, [1, 1, 1])).toEqual([-334, -333, -333])
  })

  it('stays exact when total * weight exceeds 2^53', () => {
    const out = allocateProportional(900_000_000_000, [900_000_000_001, 1, 1])
    expect(out.reduce((a, b) => a + b, 0)).toBe(900_000_000_000)
    expect(out.every(Number.isSafeInteger)).toBe(true)
  })

  it('always sums exactly to the total', () => {
    const weights = [1299, 4500, 250, 8999, 1]
    for (const total of [0, 1, 7, 100, 999, 123456]) {
      const out = allocateProportional(total, weights)
      expect(out.reduce((a, b) => a + b, 0)).toBe(total)
      expect(out.every((n) => n >= 0)).toBe(true)
    }
  })

  it('gives zeros for a zero total even when there is nothing to weigh (empty or all-free ticket)', () => {
    expect(allocateProportional(0, [])).toEqual([])
    expect(allocateProportional(0, [0, 0])).toEqual([0, 0])
  })

  it('rejects weights that cannot be allocated against', () => {
    expect(() => allocateProportional(100, [])).toThrow(RangeError)
    expect(() => allocateProportional(100, [0, 0])).toThrow(RangeError)
    expect(() => allocateProportional(0, [-1])).toThrow(RangeError)
    expect(() => allocateProportional(100, [1, -1, 5])).toThrow(RangeError)
    expect(() => allocateProportional(100, [1.5, 2])).toThrow(RangeError)
    expect(() => allocateProportional(10.5, [1, 2])).toThrow(RangeError)
  })
})
