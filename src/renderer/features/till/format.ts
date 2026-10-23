import { useTranslation } from 'react-i18next'
import type { OrderType } from '@shared/dto'
import { formatMoney } from '@shared/money'
import { pickName, type Lang, type LocalizedName } from '@shared/names'

/** The interface language, as one of the three the application speaks. */
export function useLang(): Lang {
  const { i18n } = useTranslation()
  return (['fr', 'ar', 'en'].includes(i18n.language) ? i18n.language : 'fr') as Lang
}

/** Money and names in the language of the screen. */
export function useFormat() {
  const lang = useLang()
  const { t } = useTranslation()
  return {
    lang,
    money: (cents: number): string => formatMoney(cents, lang),
    name: (n: LocalizedName): string => pickName(n, lang),
    tableName: (label: string | null | undefined): string => (label ? tableName(label) : ''),
    orderTitle: (o: { type: OrderType; tableLabel: string | null; orderNumber: number | null }): string =>
      o.tableLabel ? `${t('floor.table')} ${o.tableLabel}` : o.orderNumber !== null ? `${t('till.orderNo')} ${o.orderNumber}` : t(`till.type.${o.type}`)
  }
}

/** A table label as the floor plan shows it: `4` is `T4`; any other label is kept (`Terrasse 2`). */
export const tableName = (label: string): string => (/^\d+$/.test(label) ? `T${label}` : label)

/** `0,350 kg` from thousandths. */
export function formatQty(qtyMilli: number, byWeight = false): string {
  const whole = Math.trunc(qtyMilli / 1000)
  const frac = Math.abs(qtyMilli % 1000)
  if (byWeight) return `${whole},${String(frac).padStart(3, '0')} kg`
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(3, '0').replace(/0+$/, '')}`
}

/** Typed `0,350` or `2` -> thousandths, or null. Exact (no floating point). */
export function parseQty(text: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(text.trim())
  if (!m) return null
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
}

/** Minutes since an ISO instant. */
export const minutesSince = (iso: string, now = Date.now()): number => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
