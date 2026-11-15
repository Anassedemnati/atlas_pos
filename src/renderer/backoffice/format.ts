import { useTranslation } from 'react-i18next'
import { formatMoney, parseMoney } from '@shared/money'
import { pickName, type Lang, type LocalizedName } from '@shared/names'

/** The interface language (French when i18next holds something else). */
export function useLang(): Lang {
  const { i18n } = useTranslation()
  return i18n.language === 'ar' || i18n.language === 'en' ? i18n.language : 'fr'
}

/** A formatter set for the language: money, date and time, names, quantities. Latin digits in Arabic too (the receipts use them). */
export function useFormat() {
  const lang = useLang()
  const locale = lang === 'ar' ? 'ar-MA-u-nu-latn' : lang === 'en' ? 'en-GB' : 'fr-FR'
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 })
  return {
    lang,
    money: (cents: number): string => formatMoney(cents, lang),
    name: (name: LocalizedName | null | undefined): string => (name ? pickName(name, lang) : '-'),
    dateTime: (iso: string | null): string => (iso ? dateTime.format(new Date(iso)) : '-'),
    date: (iso: string): string => date.format(new Date(iso)),
    /** Thousandths of a unit as a number (`1500` -> `1,5`). */
    qty: (milli: number): string => number.format(milli / 1000),
    vat: (bp: number): string => `${number.format(bp / 100)} %`
  }
}

/** Integer centimes as the text of an input (`8500` -> `85,00`). */
export const centsToInput = (cents: number): string => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')}`

/** A typed amount that may be negative (a price delta: `-1,50`) as centimes, or null. */
export function parseSignedMoney(text: string): number | null {
  const trimmed = text.trim()
  const negative = trimmed.startsWith('-')
  const cents = parseMoney(negative ? trimmed.slice(1) : trimmed)
  return cents === null ? null : negative ? -cents : cents
}

/** Thousandths as the text of an input (`1500` -> `1,5`), empty for 0. */
export const milliToInput = (milli: number): string => (milli === 0 ? '' : String(milli / 1000).replace('.', ','))

/** The text of an input as thousandths, or null when it is not a number. */
export function inputToMilli(text: string): number | null {
  const clean = text.trim().replace(/\s/g, '').replace(',', '.')
  if (clean === '') return 0
  if (!/^-?\d+(\.\d{1,3})?$/.test(clean)) return null
  return Math.round(Number(clean) * 1000)
}

/** The URL a browser loads a stored `media/...` image path from. */
export const imageUrl = (imagePath: string | null | undefined): string | null =>
  imagePath ? `/${imagePath.split('/').map(encodeURIComponent).join('/')}` : null

/** The file name part of a ZIP/CSV export link, used by `<a download>`. */
export const today = (): string => {
  const now = new Date()
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}
