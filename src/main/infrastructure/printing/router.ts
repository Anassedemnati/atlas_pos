import type { Lang } from '@shared/names'
import type { PrintJob } from '../../application/ports'
import type { Database } from '../db/connection'
import type { PrinterRow } from './types'

interface PrinterDbRow {
  id: string
  name: string
  kind: string
  address: string
  width_mm: number
  lang: string
  raster: number
  role: string
  active: number
}

const toPrinter = (r: PrinterDbRow): PrinterRow => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  address: r.address,
  widthMm: r.width_mm,
  lang: r.lang as Lang,
  raster: r.raster === 1,
  role: r.role,
  active: r.active === 1
})

/** A printer by id, active or not. */
export function readPrinter(db: Database, id: string): PrinterRow | undefined {
  const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterDbRow | undefined
  return row ? toPrinter(row) : undefined
}

/**
 * The printers a job is for: the one it names (when it exists and is switched on), or the active printers of
 * its role. Ordered by id, which is creation order, so "the first" is stable.
 */
export function printersForTarget(db: Database, target: PrintJob['target']): PrinterRow[] {
  if (target.printerId !== undefined) {
    const printer = readPrinter(db, target.printerId)
    return printer?.active ? [printer] : []
  }
  if (target.role === undefined) return []
  return (db.prepare('SELECT * FROM printers WHERE role = ? AND active = 1 ORDER BY id').all(target.role) as PrinterDbRow[]).map(toPrinter)
}

/** Where kitchen lines go: category -> printers, and the printer for categories with no route. */
export interface KitchenRouting {
  byCategory: ReadonlyMap<string, readonly string[]>
  /** The first active printer with role `kitchen`. */
  fallback: string | undefined
}

/** The routing as configured now: `category_printers` of active printers, ordered by printer id. */
export function readRouting(db: Database): KitchenRouting {
  const byCategory = new Map<string, string[]>()
  const rows = db
    .prepare(
      `SELECT cp.category_id AS categoryId, cp.printer_id AS printerId
         FROM category_printers cp JOIN printers p ON p.id = cp.printer_id
        WHERE p.active = 1 ORDER BY cp.printer_id`
    )
    .all() as { categoryId: string; printerId: string }[]
  for (const { categoryId, printerId } of rows) byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), printerId])
  const fallback = (db.prepare("SELECT id FROM printers WHERE role = 'kitchen' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined)?.id
  return { byCategory, fallback }
}

/**
 * The lines of a kitchen ticket split by printer: each goes to the printers of its category, or to the first
 * kitchen printer when its category has no route (or none is known). A category may route to several printers,
 * and the line is then on each ticket. Lines for which there is nowhere to print are left out.
 */
export function routeKitchen<L extends { categoryId: string | null }>(lines: L[], routing: KitchenRouting): Map<string, L[]> {
  const out = new Map<string, L[]>()
  for (const line of lines) {
    const routed = line.categoryId === null ? undefined : routing.byCategory.get(line.categoryId)
    const targets = routed && routed.length > 0 ? routed : routing.fallback === undefined ? [] : [routing.fallback]
    for (const printerId of targets) out.set(printerId, [...(out.get(printerId) ?? []), line])
  }
  return out
}
