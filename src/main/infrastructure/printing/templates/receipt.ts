import type { TicketLineSnapshot, TicketSnapshot } from '@shared/dto'
import { formatMoney } from '@shared/money'
import { pickName, type Lang } from '@shared/names'
import type { PrintDoc } from '../types'
import { layoutDoc, type Block } from './layout'
import { formatAmount, formatDateTime, formatQty, formatRate, labelsFor, type Labels } from './labels'

export interface ReceiptOptions {
  lang: Lang
  widthMm: number
  /** A reprint: marked DUPLICATA. */
  duplicate?: boolean
  /** The printer prints images: HTML to rasterise instead of ESC/POS text. */
  raster?: boolean
  /** HTML in millimetres for a system printer. */
  paper?: boolean
  /** The business logo as a data URI; printed in HTML only. */
  logo?: string
}

const indent = '  '

const orderTypeLabel = (type: TicketSnapshot['order']['type'], L: Labels): string =>
  ({ dine_in: L.dineIn, takeaway: L.takeaway, delivery: L.delivery, counter: L.counter })[type]

/** One line of the ticket: quantity and name with the gross, then its modifiers, note, discount or offer. */
function lineBlocks(line: TicketLineSnapshot, lang: Lang, L: Labels): Block[] {
  const blocks: Block[] = [
    { kind: 'row', left: `${formatQty(line.qtyMilli)} x ${pickName(line.name, lang)}`, right: formatAmount(line.grossCents) }
  ]
  for (const m of line.modifiers) {
    const name = `${indent}+ ${pickName(m.name, lang)}`
    if (m.priceDeltaCents === 0) blocks.push({ kind: 'text', text: name })
    else blocks.push({ kind: 'row', left: name, right: formatAmount(m.priceDeltaCents) })
  }
  if (line.note) blocks.push({ kind: 'text', text: `${indent}> ${line.note}` })
  if (line.lineDiscountCents !== 0) {
    const label = line.free ? L.free : line.discount?.kind === 'pct' ? `${L.discount} ${formatRate(line.discount.bp)}` : L.discount
    blocks.push({ kind: 'row', left: `${indent}${label}`, right: formatAmount(-line.lineDiscountCents) })
  }
  return blocks
}

/** What the ticket prints, as blocks (see `layout.ts`); `receiptDoc` renders them. */
export function receiptBlocks(s: TicketSnapshot, o: ReceiptOptions): Block[] {
  const { lang } = o
  const L = labelsFor(lang)
  const b = s.business
  const center = (text: string, extra: { bold?: boolean } = {}): Block => ({ kind: 'text', text, align: 'center', ...extra })
  const blocks: Block[] = []

  if (o.logo) blocks.push({ kind: 'logo', src: o.logo })
  blocks.push({ kind: 'text', text: b.nomCommercial, align: 'center', bold: true, size: { w: 1, h: 2 } })
  for (const text of [b.adresse, b.ville]) if (text) blocks.push(center(text))
  const identity: [string, string][] = [
    [L.tel, b.telephone],
    [L.ice, b.ice],
    [L.if, b.if],
    [L.rc, b.rc],
    [L.patente, b.patente]
  ]
  for (const [label, value] of identity) if (value) blocks.push(center(`${label} : ${value}`))
  if (s.receipt.header) blocks.push(center(s.receipt.header))
  blocks.push({ kind: 'rule' })

  if (o.duplicate) blocks.push({ kind: 'text', text: `*** ${L.duplicate} ***`, align: 'center', bold: true, size: { w: 1, h: 2 } })
  blocks.push({ kind: 'text', text: `${s.kind === 'credit' ? L.credit : L.ticket} ${s.label}`, bold: true })
  if (s.ref) {
    blocks.push({ kind: 'text', text: `${L.ref} ${s.ref.label}` })
    if (s.ref.reason) blocks.push({ kind: 'text', text: `${L.reason} : ${s.ref.reason}` })
  }
  blocks.push({ kind: 'text', text: formatDateTime(s.closedAt) })
  if (s.order.number !== null) {
    blocks.push({ kind: 'text', text: `${L.orderNo} ${s.order.number}`, align: 'center', bold: true, size: { w: 2, h: 2 } })
  }
  if (s.order.table) {
    const covers = s.order.covers > 0 ? `${L.covers} : ${s.order.covers}` : ''
    blocks.push({ kind: 'row', left: `${L.table} : ${s.order.table.label}`, right: covers })
  } else if (s.order.type !== 'dine_in') {
    blocks.push({ kind: 'text', text: orderTypeLabel(s.order.type, L) })
  }
  blocks.push({ kind: 'text', text: `${L.waiter} : ${s.user.displayName}` })
  if (s.customer) {
    const name = s.customer.isCompany && s.customer.companyName ? s.customer.companyName : s.customer.name
    blocks.push({ kind: 'text', text: `${L.customer} : ${name}` })
    if (s.customer.isCompany && s.customer.ice) blocks.push({ kind: 'text', text: `${L.ice} : ${s.customer.ice}` })
  }
  blocks.push({ kind: 'rule' })

  for (const line of s.lines) blocks.push(...lineBlocks(line, lang, L))
  blocks.push({ kind: 'rule' })

  if (s.totals.ticketDiscountCents !== 0) {
    const label =
      s.ticketDiscount?.kind === 'pct' ? `${L.ticketDiscount} ${formatRate(s.ticketDiscount.bp)}` : L.ticketDiscount
    blocks.push({ kind: 'row', left: L.subtotal, right: formatAmount(s.totals.grossCents - s.totals.lineDiscountsCents) })
    blocks.push({ kind: 'row', left: label, right: formatAmount(-s.totals.ticketDiscountCents) })
  }
  blocks.push({ kind: 'row', left: L.total, right: formatMoney(s.totals.totalCents, lang), bold: true, size: { w: 1, h: 2 } })
  blocks.push({ kind: 'rule' })

  for (const v of s.vat) {
    const rate = `${L.vat} ${formatRate(v.rateBp)}`
    const ht = `${L.ht} ${formatAmount(v.ht)}`
    const vat = `${L.vat} ${formatAmount(v.vat)}`
    blocks.push({
      kind: 'fit',
      whole: `${rate} : ${ht} ${vat}`,
      rows: [
        [rate, ht],
        ['', vat]
      ]
    })
  }
  blocks.push({ kind: 'rule' })

  if (s.kind === 'credit') blocks.push({ kind: 'text', text: L.refund, bold: true })
  for (const p of s.payments) blocks.push({ kind: 'row', left: pickName(p.methodName, lang), right: formatAmount(p.tenderedCents) })
  if (s.changeCents > 0) blocks.push({ kind: 'row', left: L.change, right: formatAmount(s.changeCents), bold: true })

  if (s.receipt.footer) {
    blocks.push({ kind: 'rule' })
    blocks.push(center(s.receipt.footer))
  }
  return blocks
}

/**
 * The receipt (or credit note) of a ticket: ESC/POS text for FR and EN on a text printer, HTML to
 * rasterise when the printer prints images or the language is Arabic. Built from the frozen snapshot,
 * so a reprint is the ticket as it was.
 */
export function receiptDoc(snapshot: TicketSnapshot, opts: ReceiptOptions): PrintDoc {
  return layoutDoc(receiptBlocks(snapshot, opts), opts)
}
