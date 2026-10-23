import { AppErrorException } from '../../application/errors'

/** A discount on a line or on the whole ticket: a percentage in basis points (1000 = 10 %) or a fixed amount in centimes. */
export type Discount = { kind: 'pct'; bp: number; reason: string } | { kind: 'amount'; cents: number; reason: string }

/** Throws `invalid_discount` unless the percentage is a whole number of basis points in 0..10000 or the amount a whole number of centimes >= 0. */
export function assertDiscount(discount: Discount): void {
  const value = discount.kind === 'pct' ? discount.bp : discount.cents
  const max = discount.kind === 'pct' ? 10000 : Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new AppErrorException('invalid_discount', { kind: discount.kind, value })
  }
}

/**
 * What `discount` takes off `baseCents`, in centimes: a percentage is rounded half up to the centime,
 * and neither kind can take off more than the base.
 */
export function discountCents(baseCents: number, discount: Discount): number {
  assertDiscount(discount)
  const wanted = discount.kind === 'pct' ? Math.round((baseCents * discount.bp) / 10000) : discount.cents
  return Math.min(baseCents, wanted)
}
