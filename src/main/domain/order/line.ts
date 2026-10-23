import type { LocalizedName } from '@shared/names'
import { AppErrorException } from '../../application/errors'
import { discountCents, type Discount } from './discount'

export interface OrderLineModifier {
  id: string
  name: LocalizedName
  /** Added to the unit price; may be negative. */
  priceDeltaCents: number
  /** Set on a set-menu choice, whose `id` is then the chosen product: the course it was chosen in. */
  menuCourseId?: string
}

export interface OrderLine {
  id: string
  seq: number
  productId: string
  name: LocalizedName
  /** Thousandths of a unit: 1 item = 1000, 0,350 kg = 350. Always > 0 here. */
  qtyMilli: number
  /** TTC, per unit (per kg for a product sold by weight). */
  unitPriceCents: number
  vatBp: number
  modifiers: OrderLineModifier[]
  note: string
  /** 0 = no course, then 1, 2, 3... */
  course: number
  status: 'active' | 'void'
  /** ISO instant the line went to the kitchen, null until it is sent. */
  sentAt: string | null
  discount: Discount | null
  /** Offered: the line is on the ticket at zero. */
  free: boolean
}

/**
 * Quantity times unit price (modifiers included), rounded half up to the centime.
 * Throws `invalid_qty` unless `qtyMilli` is a whole number > 0 (a credit note is built by negating a
 * computed positive snapshot, never from a negative quantity) and `invalid_price` when the unit price
 * with its modifiers is not a whole number >= 0.
 */
export function lineGross(line: OrderLine): number {
  if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0) {
    throw new AppErrorException('invalid_qty', { lineId: line.id, qtyMilli: line.qtyMilli })
  }
  const unit = line.modifiers.reduce((sum, m) => sum + m.priceDeltaCents, line.unitPriceCents)
  if (!Number.isSafeInteger(unit) || unit < 0 || !Number.isSafeInteger(unit * line.qtyMilli)) {
    throw new AppErrorException('invalid_price', { lineId: line.id, unitCents: unit })
  }
  return Math.round((unit * line.qtyMilli) / 1000)
}

/** The gross minus the line discount; zero for a free line, whose discount is ignored. */
export function lineNet(line: OrderLine): number {
  const gross = lineGross(line)
  if (line.free) return 0
  return line.discount ? gross - discountCents(gross, line.discount) : gross
}
