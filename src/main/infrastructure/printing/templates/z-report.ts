import type { BusinessLegalDto, ZData } from '@shared/dto'
import { formatMoney } from '@shared/money'
import { pickName, type Lang } from '@shared/names'
import type { PrintDoc } from '../types'
import { layoutDoc, type Block } from './layout'
import { formatAmount, formatDateTime, formatQty, formatRate, labelsFor } from './labels'

export interface ZReportOptions {
  widthMm: number
  raster?: boolean
  paper?: boolean
  business?: Pick<BusinessLegalDto, 'nomCommercial'>
}

export function zReportBlocks(z: ZData, lang: Lang, o: ZReportOptions): Block[] {
  const L = labelsFor(lang)
  const money = (cents: number): string => formatMoney(cents, lang)
  const blocks: Block[] = []
  const section = (title: string): void => {
    blocks.push({ kind: 'rule' }, { kind: 'text', text: title, bold: true })
  }

  if (o.business) blocks.push({ kind: 'text', text: o.business.nomCommercial, align: 'center', bold: true, size: { w: 1, h: 2 } })
  blocks.push({
    kind: 'text',
    text: z.zNumber === null ? L.xReport : `${L.zReport} ${z.zNumber}`,
    align: 'center',
    bold: true,
    size: { w: 1, h: 2 }
  })
  blocks.push({ kind: 'text', text: `${L.day} ${z.dayNumber}` })
  blocks.push({ kind: 'row', left: L.openedAt, right: formatDateTime(z.openedAt) })
  if (z.closedAt) blocks.push({ kind: 'row', left: L.closedAt, right: formatDateTime(z.closedAt) })

  blocks.push({ kind: 'rule' })
  blocks.push({ kind: 'row', left: L.tickets, right: String(z.ticketsCount) })
  blocks.push({ kind: 'row', left: L.credits, right: String(z.creditsCount) })
  blocks.push({ kind: 'row', left: L.gross, right: money(z.grossCents) })
  blocks.push({ kind: 'row', left: L.discounts, right: money(-z.discountsCents) })
  blocks.push({ kind: 'row', left: L.freeItems, right: money(-z.freeItems.cents) })
  blocks.push({ kind: 'row', left: L.totalNet, right: money(z.totalCents), bold: true, size: { w: 1, h: 2 } })

  section(L.byPayment)
  for (const p of z.byPayment) blocks.push({ kind: 'row', left: `${pickName(p.name, lang)} (${p.count})`, right: formatAmount(p.cents) })

  section(L.byVat)
  for (const v of z.byVat) {
    const rate = `${L.vat} ${formatRate(v.rateBp)}`
    const ht = `${L.ht} ${formatAmount(v.ht)}`
    const vat = `${L.vat} ${formatAmount(v.vat)}`
    blocks.push({ kind: 'fit', whole: `${rate} : ${ht} ${vat}`, rows: [[rate, ht], ['', vat]] })
  }

  section(L.byCategory)
  for (const c of z.byCategory) {
    const name = c.name ? pickName(c.name, lang) : L.otherCategory
    blocks.push({ kind: 'row', left: `${name} (${formatQty(c.qtyMilli)})`, right: formatAmount(c.cents) })
  }

  section(L.byUser)
  for (const u of z.byUser) blocks.push({ kind: 'row', left: `${u.displayName} (${u.ticketsCount})`, right: formatAmount(u.cents) })

  blocks.push({ kind: 'rule' })
  blocks.push({ kind: 'row', left: `${L.voids} (${z.voids.count})`, right: money(z.voids.cents) })
  blocks.push({ kind: 'row', left: `${L.freeItems} (${z.freeItems.count})`, right: money(z.freeItems.cents) })
  blocks.push({ kind: 'row', left: L.reprints, right: String(z.reprints) })
  return blocks
}

/** The X (day so far) or Z (closed day) report, from the figures frozen with the Z. */
export function zReportDoc(z: ZData, lang: Lang, opts: ZReportOptions): PrintDoc {
  return layoutDoc(zReportBlocks(z, lang, opts), { lang, ...opts })
}
