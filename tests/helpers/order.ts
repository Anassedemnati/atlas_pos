import type { Discount } from '../../src/main/domain/order/discount'
import type { OrderLine } from '../../src/main/domain/order/line'
import { AppErrorException } from '../../src/main/application/errors'

let counter = 0

/** An active, unsent, full-price line of one unit at 10,00 DH with 10 % VAT; override what the test is about. */
export function makeLine(over: Partial<OrderLine> = {}): OrderLine {
  counter += 1
  return {
    id: `line-${counter}`,
    seq: counter,
    productId: `product-${counter}`,
    name: { fr: `Produit ${counter}` },
    qtyMilli: 1000,
    unitPriceCents: 1000,
    vatBp: 1000,
    modifiers: [],
    note: '',
    course: 0,
    status: 'active',
    sentAt: null,
    discount: null,
    free: false,
    ...over
  }
}

/** Runs `fn` and returns the code of the AppErrorException it throws (fails the test on anything else). */
export function errorCodeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppErrorException) return error.code
    throw error
  }
  throw new Error('expected an AppErrorException, nothing was thrown')
}

/** Seeded PRNG (mulberry32): the same seed always gives the same sequence, in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RATES = [2000, 1400, 1000, 700, 0]

/** A random order: mixed VAT rates, units and weights, modifiers, line and ticket discounts, free and void lines. */
export function randomOrder(random: () => number): { lines: OrderLine[]; ticketDiscount: Discount | null } {
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1))
  const chance = (p: number): boolean => random() < p

  const lines: OrderLine[] = []
  for (let i = 0, count = int(1, 8); i < count; i += 1) {
    const unitPriceCents = chance(0.05) ? 0 : int(1, 30000)
    const qtyMilli = chance(0.5) ? int(1, 5) * 1000 : int(1, 4999)
    let modifiers = Array.from({ length: int(0, 2) }, (_, m) => ({
      id: `m${m}`,
      name: { fr: `Option ${m}` },
      priceDeltaCents: int(-300, 500)
    }))
    // A modifier discount may not push the unit price below zero.
    if (unitPriceCents + modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0) < 0) modifiers = []
    const grossGuess = Math.round(((unitPriceCents + modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)) * qtyMilli) / 1000)

    let discount: Discount | null = null
    if (chance(0.3)) discount = { kind: 'pct', bp: chance(0.1) ? 10000 : int(0, 10000), reason: 'test' }
    else if (chance(0.3)) discount = { kind: 'amount', cents: int(0, Math.ceil(grossGuess * 1.5)), reason: 'test' }

    lines.push(
      makeLine({
        qtyMilli,
        unitPriceCents,
        vatBp: RATES[int(0, RATES.length - 1)],
        modifiers,
        discount,
        free: chance(0.1),
        status: chance(0.1) ? 'void' : 'active',
        course: int(0, 3)
      })
    )
  }

  let ticketDiscount: Discount | null = null
  if (chance(0.3)) ticketDiscount = { kind: 'pct', bp: chance(0.1) ? 10000 : int(0, 10000), reason: 'test' }
  else if (chance(0.3)) ticketDiscount = { kind: 'amount', cents: int(0, 200000), reason: 'test' }
  return { lines, ticketDiscount }
}
