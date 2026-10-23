import type { CategoryDto, ImportRow, MenuDto, ModifierGroupDto, ProductDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { PrinterDraft } from '@shared/setup/draft'
import type {
  Category,
  CatalogProduct,
  Menu,
  ModifierGroup,
  PaymentMethodDef,
  PermissionProfile,
  Room,
  TableDef
} from '../../../domain/config/template'
import { applyImport } from '../catalog/import-apply'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UsersRepo } from '../../../infrastructure/db/repos/users-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { slug } from '../../../infrastructure/profile/profile-io'

const json = (value: unknown): string => JSON.stringify(value)

/** Category code -> database id. */
export type CategoryIds = Map<string, string>

/**
 * Inserts a catalogue given as sections (a template's, or a profile's), in array order (`sort` = position),
 * with fresh ids. Returns the id of each category by its code. Must run inside `tx`.
 */
export function seedCatalog(
  tx: Tx,
  repo: CatalogRepo,
  s: { categories: Category[]; products: CatalogProduct[]; modifierGroups: ModifierGroup[]; menus: Menu[] }
): CategoryIds {
  const categoryIds: CategoryIds = new Map()
  s.categories.forEach((c, sort) => {
    const dto: CategoryDto = { id: newId(), name: c.name, color: c.color, sort, active: c.active, imagePath: null }
    categoryIds.set(c.code, dto.id)
    repo.insertCategory(tx, dto)
  })

  const groupIds = new Map<string, string>()
  s.modifierGroups.forEach((g, sort) => {
    const dto: ModifierGroupDto = {
      id: newId(),
      name: g.name,
      minSelect: g.min_select,
      maxSelect: g.max_select,
      modifiers: g.modifiers.map((m) => ({ id: newId(), name: m.name, priceDeltaCents: m.price_delta_cents }))
    }
    groupIds.set(g.code, dto.id)
    repo.saveModifierGroup(tx, dto, sort)
  })

  const productIds = new Map<string, string>()
  s.products.forEach((p, sort) => {
    const dto: ProductDto = {
      id: newId(),
      categoryId: categoryIds.get(p.category)!,
      name: p.name,
      priceCents: p.price_cents,
      vatBp: p.vat_bp,
      barcode: p.barcode ?? null,
      soldByWeight: p.sold_by_weight,
      color: p.color ?? null,
      imagePath: null,
      keySize: p.key_size,
      sort,
      active: p.active,
      stockTracked: p.stock_tracked,
      stockMilli: p.stock_milli,
      lowStockMilli: p.low_stock_milli,
      course: p.course,
      modifierGroupIds: p.modifier_groups.map((code) => groupIds.get(code)!)
    }
    productIds.set(p.code, dto.id)
    repo.insertProduct(tx, dto)
    if (dto.modifierGroupIds.length > 0) repo.setProductGroups(tx, dto.id, dto.modifierGroupIds)
  })

  for (const m of s.menus) {
    const dto: MenuDto = {
      id: newId(),
      productId: productIds.get(m.product)!,
      courses: m.courses.map((course) => ({
        id: newId(),
        name: course.name,
        chooseCount: course.choose_count,
        items: course.items.map((item) => ({ productId: productIds.get(item.product)!, supplementCents: item.supplement_cents }))
      }))
    }
    repo.saveMenu(tx, dto)
  }
  return categoryIds
}

/** A sheet's rows into an empty catalogue (the setup's Excel/CSV source). Categories are named by their French name: the code of each is its slug. */
export function seedImport(tx: Tx, repo: CatalogRepo, rows: ImportRow[]): CategoryIds {
  applyImport(tx, repo, rows, 'replace')
  return new Map(repo.listCategories().map((c) => [slug(c.name.fr), c.id]))
}

export function seedFloor(tx: Tx, rooms: Room[], tables: TableDef[]): void {
  const roomIds = new Map<string, string>()
  rooms.forEach((r, sort) => {
    const id = newId()
    roomIds.set(r.code, id)
    tx.db.prepare('INSERT INTO rooms (id, name_json, sort) VALUES (?, ?, ?)').run(id, json(r.name), sort)
  })
  const insert = tx.db.prepare(
    'INSERT INTO tables (id, room_id, label, shape, x, y, w, h, seats, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const t of tables) insert.run(newId(), roomIds.get(t.room), t.label, t.shape, t.x, t.y, t.w, t.h, t.seats, t.active ? 1 : 0)
}

/** Payment methods by `code`: a method that exists is updated, a new one goes last. */
export function seedPaymentMethods(tx: Tx, methods: PaymentMethodDef[]): number {
  let next = (tx.db.prepare('SELECT COALESCE(MAX(sort) + 1, 0) FROM payment_methods').pluck().get() as number) ?? 0
  let touched = 0
  for (const m of methods) {
    const existing = tx.db.prepare('SELECT id FROM payment_methods WHERE code = ?').get(m.code) as { id: string } | undefined
    if (existing) {
      tx.db.prepare('UPDATE payment_methods SET name_json = ?, opens_drawer = ?, active = ? WHERE id = ?').run(json(m.name), m.opens_drawer ? 1 : 0, m.active ? 1 : 0, existing.id)
    } else {
      tx.db
        .prepare('INSERT INTO payment_methods (id, code, name_json, opens_drawer, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId(), m.code, json(m.name), m.opens_drawer ? 1 : 0, m.active ? 1 : 0, next++)
    }
    touched++
  }
  return touched
}

/** Permission profiles, fresh ids. Returns each profile's id by its code. */
export function seedProfiles(tx: Tx, users: UsersRepo, profiles: PermissionProfile[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const p of profiles) {
    const id = newId()
    ids.set(p.code, id)
    users.insertProfile(tx, { id, name: p.name, permissions: p.permissions, maxDiscountBp: p.max_discount_bp })
  }
  return ids
}

/** The printers of the draft, fresh ids. Returns each printer's id by its `tempId`. */
export function seedPrinters(tx: Tx, printers: PrinterDraft[]): Map<string, string> {
  const ids = new Map<string, string>()
  const insert = tx.db.prepare('INSERT INTO printers (id, name, kind, address, width_mm, lang, raster, role, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const p of printers) {
    const id = newId()
    ids.set(p.tempId, id)
    insert.run(id, p.name.trim(), p.kind, p.kind === 'virtual' ? '' : p.address.trim(), p.widthMm, p.lang, p.raster ? 1 : 0, p.role, p.active ? 1 : 0)
  }
  return ids
}

/** `category_printers` from category code -> printer `tempId`s. A code with no category (an import) is skipped. */
export function seedRouting(tx: Tx, routing: Record<string, string[]>, categoryIds: CategoryIds, printerIds: Map<string, string>): void {
  const insert = tx.db.prepare('INSERT OR IGNORE INTO category_printers (category_id, printer_id) VALUES (?, ?)')
  for (const [code, tempIds] of Object.entries(routing)) {
    const categoryId = categoryIds.get(code)
    if (!categoryId) continue
    for (const tempId of tempIds) {
      const printerId = printerIds.get(tempId)
      if (printerId) insert.run(categoryId, printerId)
    }
  }
}

/** Empties the catalogue and the floor plan (sales are not looked at: the caller has checked there are none). */
export function wipeCatalogAndFloor(tx: Tx): void {
  for (const table of [
    'menu_course_items',
    'menu_courses',
    'menus',
    'product_modifier_groups',
    'modifiers',
    'modifier_groups',
    'products',
    'category_printers',
    'categories',
    'tables',
    'rooms'
  ]) {
    tx.db.exec(`DELETE FROM ${table}`)
  }
}
