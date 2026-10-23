import type { OrderType } from '@shared/dto'
import { pickName, type Lang, type LocalizedName } from '@shared/names'
import type { PrintDoc } from '../types'
import { layoutDoc, type Block } from './layout'
import { formatDateTime, formatQty, labelsFor, type Labels } from './labels'

/** What a kitchen ticket shows of the order, frozen when it is sent. */
export interface KitchenOrderInfo {
  type: OrderType
  tableLabel: string | null
  covers: number
  /** Café / snack counter number. */
  orderNumber: number | null
  /** Who rang the order. */
  waiter: string
  /** ISO time the lines were sent. */
  at: string
  note: string
}

/** A line as the kitchen reads it: quantity, name, choices, note. No prices. */
export interface KitchenLine {
  id: string
  name: LocalizedName
  qtyMilli: number
  modifiers: { name: LocalizedName }[]
  note: string
  /** 0 = no course. */
  course: number
}

export interface KitchenOptions {
  /** The language of the printer. */
  lang: Lang
  widthMm: number
  raster?: boolean
  paper?: boolean
  /** A cancellation: the lines are marked ANNULÉ so the kitchen stops making them. */
  cancelled?: boolean
}

const typeLabel = (type: OrderType, L: Labels): string =>
  ({ dine_in: L.dineIn, takeaway: L.takeaway, delivery: L.delivery, counter: L.counter })[type]

export function kitchenBlocks(order: KitchenOrderInfo, lines: KitchenLine[], o: KitchenOptions): Block[] {
  const L = labelsFor(o.lang)
  const big = { w: 2, h: 2 } as const
  const tall = { w: 1, h: 2 } as const
  const blocks: Block[] = []

  if (o.cancelled) blocks.push({ kind: 'text', text: `*** ${L.cancelled} ***`, align: 'center', bold: true, size: big })
  if (order.tableLabel) blocks.push({ kind: 'text', text: `${L.table} ${order.tableLabel}`, align: 'center', bold: true, size: big })
  if (order.orderNumber !== null) blocks.push({ kind: 'text', text: `N° ${order.orderNumber}`, align: 'center', bold: true, size: big })
  if (!order.tableLabel && order.type !== 'dine_in') {
    blocks.push({ kind: 'text', text: typeLabel(order.type, L), align: 'center', bold: true })
  }
  const covers = order.covers > 0 ? `${L.covers} : ${order.covers}` : ''
  blocks.push({ kind: 'row', left: covers, right: `${L.waiter} : ${order.waiter}` })
  blocks.push({ kind: 'text', text: formatDateTime(order.at) })
  if (order.note) blocks.push({ kind: 'text', text: `${L.note} : ${order.note}`, bold: true })
  blocks.push({ kind: 'rule', heavy: true })

  const courses = [...new Set(lines.map((l) => l.course))].sort((a, b) => a - b)
  for (const course of courses) {
    if (courses.length > 1 || course > 0) {
      blocks.push({ kind: 'text', text: `-- ${L.course} ${course} --`, align: 'center', bold: true })
    }
    for (const line of lines.filter((l) => l.course === course)) {
      blocks.push({ kind: 'text', text: `${formatQty(line.qtyMilli)} x ${pickName(line.name, o.lang)}`, bold: true, size: tall })
      for (const m of line.modifiers) blocks.push({ kind: 'text', text: `  + ${pickName(m.name, o.lang)}` })
      if (line.note) blocks.push({ kind: 'text', text: `  > ${line.note}`, bold: true })
    }
  }
  blocks.push({ kind: 'rule', heavy: true })
  return blocks
}

/**
 * A kitchen (or bar) ticket: large type, table or order number, covers, waiter, time, the lines by course
 * with their choices and notes. The language is the printer's.
 */
export function kitchenDoc(order: KitchenOrderInfo, lines: KitchenLine[], opts: KitchenOptions): PrintDoc {
  return layoutDoc(kitchenBlocks(order, lines, opts), opts)
}
