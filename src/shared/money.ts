import type { Lang } from './names'

/** Narrow no-break space: the thousands separator in every language. */
const THOUSANDS_SEPARATOR = ' '

const CURRENCY: Record<Lang, string> = { fr: 'DH', en: 'DH', ar: 'درهم' }

/** Integer centimes -> `2 450,00 DH` (fr, en) or `2 450,00 درهم` (ar). */
export function formatMoney(cents: number, lang: Lang): string {
  const rounded = Math.round(cents)
  const abs = Math.abs(rounded)
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR)
  const fraction = String(abs % 100).padStart(2, '0')
  const sign = rounded < 0 ? '-' : ''
  return `${sign}${whole},${fraction} ${CURRENCY[lang]}`
}

const AMOUNT = /^(\d+)(?:[.,](\d{1,2}))?$/

/**
 * Typed amount -> integer centimes, or null when it is not a valid amount.
 * Accepts `38`, `38,5`, `38.50`, `1 200,00` (any space as thousands separator).
 * Exact decimal parsing: no floating point involved.
 */
export function parseMoney(input: string): number | null {
  const match = AMOUNT.exec(input.replace(/\s/g, ''))
  if (!match) return null
  const [, whole, fraction = ''] = match
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}
