import type { Clock } from '../../application/ports'
import type { Database } from '../db/connection'
import { createOrdersRepo } from '../db/repos/orders-repo'
import type { KitchenLine, KitchenOrderInfo } from './templates/kitchen'

/** A kitchen ticket frozen at the moment it is queued: what a retry or a reprint prints. */
export interface KitchenTicket {
  order: KitchenOrderInfo
  lines: KitchenLine[]
}

export interface KitchenSource {
  order: KitchenOrderInfo
  /** The lines asked for, in order, each with the category that decides its printer. */
  lines: (KitchenLine & { categoryId: string | null })[]
}

/**
 * Reads, inside the caller's transaction, what a kitchen ticket shows: the order header and the given lines
 * (void ones included, for a cancellation) with their category. Undefined when the order or none of the lines exist.
 */
export function readKitchenSource(db: Database, clock: Clock, orderId: string, lineIds: string[]): KitchenSource | undefined {
  const order = createOrdersRepo(db).get(orderId)
  if (!order) return undefined
  const wanted = new Set(lineIds)
  const chosen = order.lines.filter((line) => wanted.has(line.id))
  if (chosen.length === 0) return undefined

  const categories = new Map<string, string>()
  const productIds = [...new Set(chosen.map((l) => l.productId))]
  const rows = db
    .prepare(`SELECT id, category_id AS categoryId FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`)
    .all(...productIds) as { id: string; categoryId: string }[]
  for (const row of rows) categories.set(row.id, row.categoryId)

  const waiter = (db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(order.userId) as { name: string } | undefined)?.name ?? ''
  return {
    order: {
      type: order.type,
      tableLabel: order.tableLabel,
      covers: order.covers,
      orderNumber: order.orderNumber,
      waiter,
      // When the ticket is queued: a send has just stamped its lines with this time, a cancellation is now.
      at: clock.now().toISOString(),
      note: order.note
    },
    lines: chosen.map((l) => ({
      id: l.id,
      name: l.name,
      qtyMilli: l.qtyMilli,
      modifiers: l.modifiers.map((m) => ({ name: m.name })),
      note: l.note,
      course: l.course,
      categoryId: categories.get(l.productId) ?? null
    }))
  }
}
