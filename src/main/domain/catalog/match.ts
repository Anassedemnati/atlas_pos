import type { ImportRow, ProductDto } from '@shared/dto'
import { nameKey } from './fields'

/**
 * The existing product each sheet row stands for, or `undefined` when the row is a new product.
 * 1. A row with a barcode is the product that has it.
 * 2. Otherwise (or when no product has that barcode) it is the first product of the same category
 *    with the same French name (case- and spacing-insensitive). A row that carries a barcode only
 *    takes a product that has none: so a barcode is added to a product, never moved from one product
 *    to another, and the unique barcode index can never be hit.
 * A product stands for at most one row (two rows with the same name are two products, as in a file).
 * `categoryKeyById` maps a category id to `nameKey(its French name)`.
 */
export function matchRows(
  rows: ImportRow[],
  products: ProductDto[],
  categoryKeyById: ReadonlyMap<string, string>
): (ProductDto | undefined)[] {
  const targets: (ProductDto | undefined)[] = rows.map(() => undefined)
  const claimed = new Set<string>()

  const byBarcode = new Map<string, ProductDto>()
  for (const p of products) if (p.barcode !== null) byBarcode.set(p.barcode, p)
  rows.forEach((row, i) => {
    const found = row.barcode === undefined ? undefined : byBarcode.get(row.barcode)
    if (found) {
      targets[i] = found
      claimed.add(found.id)
    }
  })

  const keyOf = (category: string, name: string): string => `${category}\u0000${nameKey(name)}`
  const byName = new Map<string, ProductDto[]>()
  for (const p of products) {
    const key = keyOf(categoryKeyById.get(p.categoryId) ?? '', p.name.fr)
    byName.set(key, [...(byName.get(key) ?? []), p])
  }
  rows.forEach((row, i) => {
    if (targets[i]) return
    const candidates = byName.get(keyOf(nameKey(row.category), row.nameFr)) ?? []
    const found = candidates.find((p) => !claimed.has(p.id) && (row.barcode === undefined || p.barcode === null))
    if (found) {
      targets[i] = found
      claimed.add(found.id)
    }
  })
  return targets
}
