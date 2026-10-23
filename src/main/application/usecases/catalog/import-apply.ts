import type { CategoryDto, ImportMode, ImportRow, ImportSummary, ProductDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { LocalizedName } from '@shared/names'
import { DEFAULT_CATEGORY_COLOR, nameKey, productDefaults } from '../../../domain/catalog/fields'
import { matchRows } from '../../../domain/catalog/match'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { Tx } from '../../../infrastructure/db/uow'

const localized = (row: ImportRow, existing: LocalizedName | undefined, replace: boolean): LocalizedName => {
  // merge: an empty cell leaves the translation as it is; replace: the sheet is the whole truth.
  const ar = row.nameAr ?? (replace ? undefined : existing?.ar)
  const en = row.nameEn ?? (replace ? undefined : existing?.en)
  return { fr: row.nameFr, ...(ar ? { ar } : {}), ...(en ? { en } : {}) }
}

/**
 * Writes validated rows into the catalogue, inside the caller's transaction (so a failure anywhere
 * rolls everything back). Categories are matched, or created, by French name. Products are matched
 * by `matchRows`; a matched product is updated and reactivated.
 *
 * `merge`: only what the sheet carries is written, and an empty optional cell (translation, barcode,
 * colour, stock) leaves the product's value; new categories and products go last.
 * `replace`: the sheet is the whole truth. Empty cells clear, the order is the file's, and the
 * products and categories the file does not list go: removed, or made inactive when a product was
 * sold or is in a set menu (a category that still holds such a product is made inactive).
 */
export function applyImport(tx: Tx, repo: CatalogRepo, rows: ImportRow[], mode: ImportMode): ImportSummary {
  const replace = mode === 'replace'
  const summary: ImportSummary = { mode, categoriesCreated: 0, created: 0, updated: 0, deleted: 0, deactivated: 0 }
  const categories = repo.listCategories()
  const products = repo.listProducts()

  // Categories, in order of first appearance.
  const categoryByKey = new Map<string, CategoryDto>()
  for (const category of categories) {
    const key = nameKey(category.name.fr)
    if (!categoryByKey.has(key)) categoryByKey.set(key, category)
  }
  let nextCategorySort = categories.reduce((next, c) => Math.max(next, c.sort + 1), 0)
  const categoryIdByKey = new Map<string, string>()
  for (const row of rows) {
    const key = nameKey(row.category)
    if (categoryIdByKey.has(key)) continue
    const existing = categoryByKey.get(key)
    if (existing) {
      categoryIdByKey.set(key, existing.id)
      if (!existing.active) repo.updateCategory(tx, { ...existing, active: true })
    } else {
      const created: CategoryDto = {
        id: newId(),
        name: { fr: row.category },
        color: DEFAULT_CATEGORY_COLOR,
        sort: nextCategorySort++,
        active: true,
        imagePath: null
      }
      repo.insertCategory(tx, created)
      categoryIdByKey.set(key, created.id)
      summary.categoriesCreated++
    }
  }

  // Products.
  const categoryKeyById = new Map(categories.map((c) => [c.id, nameKey(c.name.fr)]))
  const targets = matchRows(rows, products, categoryKeyById)
  let nextProductSort = products.reduce((next, p) => Math.max(next, p.sort + 1), 0)
  const idsInOrder: string[] = []
  rows.forEach((row, index) => {
    const categoryId = categoryIdByKey.get(nameKey(row.category))!
    const existing = targets[index]
    // The sheet's `stock` is a starting quantity: it sets the stock of a new product, or of one that
    // starts being tracked. A product already tracked keeps its live quantity (sales moved it since the
    // sheet was written, and an adjustment is the only audited way to change it).
    const stock =
      row.stockMilli === undefined
        ? { stockTracked: replace ? false : (existing?.stockTracked ?? false), stockMilli: existing?.stockMilli ?? 0 }
        : { stockTracked: true, stockMilli: existing?.stockTracked ? existing.stockMilli : row.stockMilli }
    if (existing) {
      repo.updateProduct(tx, {
        ...existing,
        categoryId,
        name: localized(row, existing.name, replace),
        priceCents: row.priceCents,
        vatBp: row.vatBp,
        barcode: row.barcode ?? (replace ? null : existing.barcode),
        soldByWeight: row.soldByWeight,
        color: row.color ?? (replace ? null : existing.color),
        active: true,
        ...stock
      })
      idsInOrder.push(existing.id)
      summary.updated++
    } else {
      const created: ProductDto = {
        ...productDefaults(),
        id: newId(),
        categoryId,
        name: localized(row, undefined, replace),
        priceCents: row.priceCents,
        vatBp: row.vatBp,
        barcode: row.barcode ?? null,
        soldByWeight: row.soldByWeight,
        color: row.color ?? null,
        sort: nextProductSort++,
        ...stock
      }
      repo.insertProduct(tx, created)
      idsInOrder.push(created.id)
      summary.created++
    }
  })
  if (!replace) return summary

  // Replace: what the file does not list goes.
  const listed = new Set(idsInOrder)
  const referenced = repo.referencedProductIds()
  for (const product of products) {
    if (listed.has(product.id)) continue
    if (referenced.has(product.id)) {
      if (product.active) {
        repo.updateProduct(tx, { ...product, active: false })
        summary.deactivated++
      }
    } else {
      repo.deleteProduct(tx, product.id)
      summary.deleted++
    }
  }
  repo.setSort(tx, 'product', idsInOrder)

  const fileCategoryIds = [...categoryIdByKey.values()]
  const inFile = new Set(fileCategoryIds)
  const others: string[] = []
  for (const category of repo.listCategories()) {
    if (inFile.has(category.id)) continue
    if (repo.countProductsInCategory(category.id) === 0) repo.deleteCategory(tx, category.id)
    else {
      if (category.active) repo.updateCategory(tx, { ...category, active: false })
      others.push(category.id)
    }
  }
  repo.setSort(tx, 'category', [...fileCategoryIds, ...others])
  return summary
}
