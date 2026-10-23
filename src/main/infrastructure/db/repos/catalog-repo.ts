import type { CatalogDto, CategoryDto, MenuDto, ModifierGroupDto, ProductDto } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { Database } from '../connection'
import type { Tx } from '../uow'

interface CategoryRow {
  id: string
  name_json: string
  color: string
  sort: number
  active: number
  image_path: string | null
}

interface ProductRow {
  id: string
  category_id: string
  name_json: string
  price_cents: number
  vat_bp: number
  barcode: string | null
  sold_by_weight: number
  color: string | null
  image_path: string | null
  key_size: number
  sort: number
  active: number
  stock_tracked: number
  stock_milli: number
  low_stock_milli: number
  course: number
}

/** The tables with a `sort` column that `reorder` may touch. */
export type SortableKind = 'category' | 'product' | 'modifierGroup'
const SORT_TABLE = { category: 'categories', product: 'products', modifierGroup: 'modifier_groups' } as const

const json = (value: unknown): string => JSON.stringify(value)

/** A stored name; a row whose JSON does not read still lists (under its id), so it can be fixed. */
function nameOf(text: string, fallback: string): LocalizedName {
  try {
    const parsed = JSON.parse(text) as Partial<LocalizedName> | null
    if (parsed && typeof parsed.fr === 'string') {
      return {
        fr: parsed.fr,
        ...(typeof parsed.ar === 'string' && parsed.ar !== '' ? { ar: parsed.ar } : {}),
        ...(typeof parsed.en === 'string' && parsed.en !== '' ? { en: parsed.en } : {})
      }
    }
  } catch {
    // falls through
  }
  return { fr: fallback }
}

const toCategory = (row: CategoryRow): CategoryDto => ({
  id: row.id,
  name: nameOf(row.name_json, row.id),
  color: row.color,
  sort: row.sort,
  active: row.active === 1,
  imagePath: row.image_path
})

const toProduct = (row: ProductRow, modifierGroupIds: string[]): ProductDto => ({
  id: row.id,
  categoryId: row.category_id,
  name: nameOf(row.name_json, row.id),
  priceCents: row.price_cents,
  vatBp: row.vat_bp,
  barcode: row.barcode,
  soldByWeight: row.sold_by_weight === 1,
  color: row.color,
  imagePath: row.image_path,
  keySize: row.key_size,
  sort: row.sort,
  active: row.active === 1,
  stockTracked: row.stock_tracked === 1,
  stockMilli: row.stock_milli,
  lowStockMilli: row.low_stock_milli,
  course: row.course,
  modifierGroupIds
})

export interface CatalogRepo {
  /** The whole catalogue in display order (`sort`, then id), inactive items included. */
  list(): CatalogDto
  listCategories(): CategoryDto[]
  getCategory(id: string): CategoryDto | undefined
  listProducts(): ProductDto[]
  getProduct(id: string): ProductDto | undefined
  getModifierGroup(id: string): ModifierGroupDto | undefined
  /** The id of the product holding this barcode. */
  findProductByBarcode(barcode: string): string | undefined
  /** The id of the menu of this product. */
  findMenuByProduct(productId: string): string | undefined
  countProductsInCategory(categoryId: string): number
  /** The first of `ids` that is not a row of `kind`. */
  firstMissing(kind: SortableKind, ids: string[]): string | undefined
  /** Sold (an order line) or offered in a set menu: such a product is kept, as inactive, never deleted. */
  isProductReferenced(productId: string): boolean
  /** The same, for every product at once (one pass, for the many products of a replace import). */
  referencedProductIds(): Set<string>
  /** The next `sort` after the last one of the table. */
  nextSort(kind: SortableKind): number

  insertCategory(tx: Tx, category: CategoryDto): void
  updateCategory(tx: Tx, category: CategoryDto): void
  deleteCategory(tx: Tx, id: string): void

  insertProduct(tx: Tx, product: ProductDto): void
  /** Writes every field but `sort`; the modifier groups are `setProductGroups`. */
  updateProduct(tx: Tx, product: ProductDto): void
  setProductGroups(tx: Tx, productId: string, groupIds: string[]): void
  /** Removes the product and its own menu. The caller has checked `isProductReferenced`. */
  deleteProduct(tx: Tx, id: string): void
  /** Counts in SQL, never from a value read earlier. Returns the new quantity. */
  addStock(tx: Tx, productId: string, deltaMilli: number): number

  /** Inserts or updates the group, and makes its modifiers exactly `group.modifiers` (in order). */
  saveModifierGroup(tx: Tx, group: ModifierGroupDto, sort?: number): void
  /** Inserts or updates the menu, and makes its courses exactly `menu.courses` (in order). */
  saveMenu(tx: Tx, menu: MenuDto): void

  /** `sort` = position in `ids`. */
  setSort(tx: Tx, kind: SortableKind, ids: string[]): void
}

export function createCatalogRepo(db: Database): CatalogRepo {
  const groupIdsByProduct = (): Map<string, string[]> => {
    const rows = db
      .prepare(
        `SELECT l.product_id, l.group_id FROM product_modifier_groups l
         JOIN modifier_groups g ON g.id = l.group_id ORDER BY g.sort, g.id`
      )
      .all() as { product_id: string; group_id: string }[]
    const out = new Map<string, string[]>()
    for (const { product_id, group_id } of rows) out.set(product_id, [...(out.get(product_id) ?? []), group_id])
    return out
  }

  const listProducts = (): ProductDto[] => {
    const links = groupIdsByProduct()
    return (db.prepare('SELECT * FROM products ORDER BY sort, id').all() as ProductRow[]).map((row) =>
      toProduct(row, links.get(row.id) ?? [])
    )
  }

  const listModifierGroups = (): ModifierGroupDto[] => {
    const modifiers = db.prepare('SELECT * FROM modifiers ORDER BY sort, id').all() as {
      id: string
      group_id: string
      name_json: string
      price_delta_cents: number
    }[]
    return (
      db.prepare('SELECT * FROM modifier_groups ORDER BY sort, id').all() as {
        id: string
        name_json: string
        min_select: number
        max_select: number
      }[]
    ).map((g) => ({
      id: g.id,
      name: nameOf(g.name_json, g.id),
      minSelect: g.min_select,
      maxSelect: g.max_select,
      modifiers: modifiers
        .filter((m) => m.group_id === g.id)
        .map((m) => ({ id: m.id, name: nameOf(m.name_json, m.id), priceDeltaCents: m.price_delta_cents }))
    }))
  }

  const listMenus = (): MenuDto[] => {
    const courses = db.prepare('SELECT * FROM menu_courses ORDER BY sort, id').all() as {
      id: string
      menu_id: string
      name_json: string
      choose_count: number
    }[]
    const items = db.prepare('SELECT * FROM menu_course_items ORDER BY rowid').all() as {
      course_id: string
      product_id: string
      supplement_cents: number
    }[]
    return (db.prepare('SELECT * FROM menus ORDER BY id').all() as { id: string; product_id: string }[]).map((m) => ({
      id: m.id,
      productId: m.product_id,
      courses: courses
        .filter((c) => c.menu_id === m.id)
        .map((c) => ({
          id: c.id,
          name: nameOf(c.name_json, c.id),
          chooseCount: c.choose_count,
          items: items
            .filter((i) => i.course_id === c.id)
            .map((i) => ({ productId: i.product_id, supplementCents: i.supplement_cents }))
        }))
    }))
  }

  const listCategories = (): CategoryDto[] =>
    (db.prepare('SELECT * FROM categories ORDER BY sort, id').all() as CategoryRow[]).map(toCategory)

  const exists = (conn: Database, sql: string, ...args: unknown[]): boolean => conn.prepare(sql).get(...args) !== undefined

  return {
    list: () => ({
      categories: listCategories(),
      products: listProducts(),
      modifierGroups: listModifierGroups(),
      menus: listMenus()
    }),
    listCategories,
    listProducts,

    getCategory(id) {
      const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined
      return row ? toCategory(row) : undefined
    },

    getProduct(id) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
      if (!row) return undefined
      const groups = db
        .prepare(
          `SELECT l.group_id FROM product_modifier_groups l JOIN modifier_groups g ON g.id = l.group_id
           WHERE l.product_id = ? ORDER BY g.sort, g.id`
        )
        .all(id) as { group_id: string }[]
      return toProduct(
        row,
        groups.map((g) => g.group_id)
      )
    },

    getModifierGroup: (id) => listModifierGroups().find((g) => g.id === id),

    findProductByBarcode: (barcode) =>
      (db.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode) as { id: string } | undefined)?.id,

    findMenuByProduct: (productId) =>
      (db.prepare('SELECT id FROM menus WHERE product_id = ?').get(productId) as { id: string } | undefined)?.id,

    countProductsInCategory: (categoryId) =>
      (db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(categoryId) as { n: number }).n,

    firstMissing(kind, ids) {
      const table = SORT_TABLE[kind]
      return ids.find((id) => !exists(db, `SELECT 1 FROM ${table} WHERE id = ?`, id))
    },

    isProductReferenced: (productId) =>
      exists(db, 'SELECT 1 FROM order_lines WHERE product_id = ? LIMIT 1', productId) ||
      exists(db, 'SELECT 1 FROM menu_course_items WHERE product_id = ? LIMIT 1', productId),

    referencedProductIds() {
      const rows = db
        .prepare(
          `SELECT product_id FROM order_lines UNION SELECT product_id FROM menu_course_items`
        )
        .all() as { product_id: string }[]
      return new Set(rows.map((r) => r.product_id))
    },

    nextSort: (kind) =>
      ((db.prepare(`SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM ${SORT_TABLE[kind]}`).get() as { next: number }).next),

    insertCategory: (tx, c) => {
      tx.db
        .prepare('INSERT INTO categories (id, name_json, color, sort, active, image_path) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, json(c.name), c.color, c.sort, c.active ? 1 : 0, c.imagePath)
    },

    updateCategory: (tx, c) => {
      tx.db
        .prepare('UPDATE categories SET name_json = ?, color = ?, active = ?, image_path = ? WHERE id = ?')
        .run(json(c.name), c.color, c.active ? 1 : 0, c.imagePath, c.id)
    },

    deleteCategory: (tx, id) => {
      tx.db.prepare('DELETE FROM categories WHERE id = ?').run(id)
    },

    insertProduct: (tx, p) => {
      tx.db
        .prepare(
          `INSERT INTO products (id, category_id, name_json, price_cents, vat_bp, barcode, sold_by_weight, color,
                                 image_path, key_size, sort, active, stock_tracked, stock_milli, low_stock_milli, course)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.id,
          p.categoryId,
          json(p.name),
          p.priceCents,
          p.vatBp,
          p.barcode,
          p.soldByWeight ? 1 : 0,
          p.color,
          p.imagePath,
          p.keySize,
          p.sort,
          p.active ? 1 : 0,
          p.stockTracked ? 1 : 0,
          p.stockMilli,
          p.lowStockMilli,
          p.course
        )
    },

    updateProduct: (tx, p) => {
      tx.db
        .prepare(
          `UPDATE products SET category_id = ?, name_json = ?, price_cents = ?, vat_bp = ?, barcode = ?,
                  sold_by_weight = ?, color = ?, image_path = ?, key_size = ?, active = ?, stock_tracked = ?,
                  stock_milli = ?, low_stock_milli = ?, course = ?
           WHERE id = ?`
        )
        .run(
          p.categoryId,
          json(p.name),
          p.priceCents,
          p.vatBp,
          p.barcode,
          p.soldByWeight ? 1 : 0,
          p.color,
          p.imagePath,
          p.keySize,
          p.active ? 1 : 0,
          p.stockTracked ? 1 : 0,
          p.stockMilli,
          p.lowStockMilli,
          p.course,
          p.id
        )
    },

    setProductGroups: (tx, productId, groupIds) => {
      tx.db.prepare('DELETE FROM product_modifier_groups WHERE product_id = ?').run(productId)
      const insert = tx.db.prepare('INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?, ?)')
      for (const groupId of groupIds) insert.run(productId, groupId)
    },

    deleteProduct: (tx, id) => {
      const menu = tx.db.prepare('SELECT id FROM menus WHERE product_id = ?').get(id) as { id: string } | undefined
      if (menu) deleteMenuRows(tx, menu.id)
      // product_modifier_groups goes with it (ON DELETE CASCADE).
      tx.db.prepare('DELETE FROM products WHERE id = ?').run(id)
    },

    addStock: (tx, productId, deltaMilli) => {
      tx.db.prepare('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ?').run(deltaMilli, productId)
      return (tx.db.prepare('SELECT stock_milli AS n FROM products WHERE id = ?').get(productId) as { n: number }).n
    },

    saveModifierGroup: (tx, group, sort = 0) => {
      const known = tx.db.prepare('SELECT id FROM modifiers WHERE group_id = ?').all(group.id) as { id: string }[]
      if (exists(tx.db, 'SELECT 1 FROM modifier_groups WHERE id = ?', group.id)) {
        tx.db
          .prepare('UPDATE modifier_groups SET name_json = ?, min_select = ?, max_select = ? WHERE id = ?')
          .run(json(group.name), group.minSelect, group.maxSelect, group.id)
      } else {
        tx.db
          .prepare('INSERT INTO modifier_groups (id, name_json, min_select, max_select, sort) VALUES (?, ?, ?, ?, ?)')
          .run(group.id, json(group.name), group.minSelect, group.maxSelect, sort)
      }
      const kept = new Set(group.modifiers.map((m) => m.id))
      for (const { id } of known) {
        if (!kept.has(id)) tx.db.prepare('DELETE FROM modifiers WHERE id = ?').run(id)
      }
      const knownIds = new Set(known.map((k) => k.id))
      group.modifiers.forEach((m, position) => {
        if (knownIds.has(m.id)) {
          tx.db
            .prepare('UPDATE modifiers SET name_json = ?, price_delta_cents = ?, sort = ? WHERE id = ?')
            .run(json(m.name), m.priceDeltaCents, position, m.id)
        } else {
          tx.db
            .prepare('INSERT INTO modifiers (id, group_id, name_json, price_delta_cents, sort) VALUES (?, ?, ?, ?, ?)')
            .run(m.id, group.id, json(m.name), m.priceDeltaCents, position)
        }
      })
    },

    saveMenu: (tx, menu) => {
      if (exists(tx.db, 'SELECT 1 FROM menus WHERE id = ?', menu.id)) deleteCourseRows(tx, menu.id)
      else tx.db.prepare('INSERT INTO menus (id, product_id) VALUES (?, ?)').run(menu.id, menu.productId)
      menu.courses.forEach((course, position) => {
        tx.db
          .prepare('INSERT INTO menu_courses (id, menu_id, name_json, sort, choose_count) VALUES (?, ?, ?, ?, ?)')
          .run(course.id, menu.id, json(course.name), position, course.chooseCount)
        for (const item of course.items) {
          tx.db
            .prepare('INSERT INTO menu_course_items (course_id, product_id, supplement_cents) VALUES (?, ?, ?)')
            .run(course.id, item.productId, item.supplementCents)
        }
      })
    },

    setSort: (tx, kind, ids) => {
      const update = tx.db.prepare(`UPDATE ${SORT_TABLE[kind]} SET sort = ? WHERE id = ?`)
      ids.forEach((id, position) => update.run(position, id))
    }
  }
}

/** Items first, then courses: neither table cascades. */
function deleteCourseRows(tx: Tx, menuId: string): void {
  tx.db
    .prepare('DELETE FROM menu_course_items WHERE course_id IN (SELECT id FROM menu_courses WHERE menu_id = ?)')
    .run(menuId)
  tx.db.prepare('DELETE FROM menu_courses WHERE menu_id = ?').run(menuId)
}

function deleteMenuRows(tx: Tx, menuId: string): void {
  deleteCourseRows(tx, menuId)
  tx.db.prepare('DELETE FROM menus WHERE id = ?').run(menuId)
}
