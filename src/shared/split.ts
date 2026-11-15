import { allocateProportional } from './vat'

/**
 * `totalCents` in `parts` equal shares, the odd centimes going to the first shares (27100 in 3: 9034, 9033, 9033);
 * the shares add up to the total. The caller has checked `totalCents >= 0` and `parts >= 1`.
 */
export const equalShares = (totalCents: number, parts: number): number[] =>
  allocateProportional(totalCents, Array.from({ length: parts }, () => 1))
