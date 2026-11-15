/** Splits a TTC amount (integer centimes) into HT and VAT; `ht + vat === ttc` always. */
export function splitTtc(ttcCents: number, rateBp: number): { ht: number; vat: number } {
  const ht = Math.round((ttcCents * 10000) / (10000 + rateBp))
  return { ht, vat: ttcCents - ht }
}

export type VatRow = { rateBp: number; ttc: number; ht: number; vat: number }

/** VAT per rate: lines are grouped by rate first, then split once per group. Highest rate first. */
export function vatBreakdown(lines: { ttc: number; rateBp: number }[]): VatRow[] {
  const ttcByRate = new Map<number, number>()
  for (const line of lines) {
    ttcByRate.set(line.rateBp, (ttcByRate.get(line.rateBp) ?? 0) + line.ttc)
  }
  return [...ttcByRate]
    .sort(([a], [b]) => b - a)
    .map(([rateBp, ttc]) => ({ rateBp, ttc, ...splitTtc(ttc, rateBp) }))
}

/**
 * Spreads `total` (integer centimes) over `weights` proportionally, largest remainder method:
 * the result sums exactly to `total`. Ties go to the lowest index. Exact, via BigInt, so that
 * `total * weight` cannot lose precision. A zero total gives zeros (also for empty or all-zero
 * weights). Throws RangeError when no allocation is possible: non-integer total, negative or
 * non-integer weight, or a non-zero total with empty or all-zero weights.
 */
export function allocateProportional(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new RangeError(`total must be a safe integer, got ${total}`)
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('weights must be non-negative safe integers')
  }
  // Nothing to spread: an empty or all-free ticket recomputes to zeros instead of failing.
  if (total === 0) return weights.map(() => 0)
  const weightSum = weights.reduce((sum, w) => sum + BigInt(w), 0n)
  if (weightSum === 0n) throw new RangeError('cannot allocate a non-zero total over empty or all-zero weights')

  const sign = total < 0 ? -1n : 1n
  const magnitude = BigInt(total) * sign
  const shares = weights.map((w) => {
    const product = magnitude * BigInt(w)
    return { floor: product / weightSum, remainder: product % weightSum }
  })
  const leftover = Number(magnitude - shares.reduce((sum, s) => sum + s.floor, 0n))

  const byRemainderDesc = shares
    .map((_, index) => index)
    .sort((a, b) => {
      const ra = shares[a].remainder
      const rb = shares[b].remainder
      return ra === rb ? a - b : ra > rb ? -1 : 1
    })
  const out = shares.map((s) => s.floor)
  for (const index of byRemainderDesc.slice(0, leftover)) out[index] += 1n
  return out.map((n) => Number(n * sign))
}
