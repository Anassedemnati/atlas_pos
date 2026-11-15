import { newId } from '../../src/shared/ids'
import type { Database } from '../../src/main/infrastructure/db/connection'
import type {
  Category,
  CatalogProduct,
  Menu,
  ModifierGroup,
  PaymentMethodDef,
  PermissionProfile,
  Room,
  TableDef
} from '../../src/main/domain/config/template'
import type { PrinterDef } from '../../src/main/infrastructure/profile/profile-io'

/** What a finished setup puts into the database, in the shape shared by templates and profiles. */
export interface SetupInput {
  categories: Category[]
  products: CatalogProduct[]
  modifierGroups: ModifierGroup[]
  menus: Menu[]
  rooms: Room[]
  tables: TableDef[]
  paymentMethods: PaymentMethodDef[]
  profiles: PermissionProfile[]
  printers?: PrinterDef[]
  /** category code -> printer codes */
  routing?: Record<string, string[]>
}

const json = (value: unknown): string => JSON.stringify(value)

/**
 * Test-only stand-in for the setup use case (Task 16): inserts a setup with fresh ids, in array
 * order. Rows get UUIDv7 ids and `sort` = position, exactly as the real use case will.
 */
export function seedSetup(db: Database, s: SetupInput): void {
  db.transaction(() => {
    const categoryId = new Map<string, string>()
    s.categories.forEach((c, sort) => {
      const id = newId()
      categoryId.set(c.code, id)
      db.prepare('INSERT INTO categories (id, name_json, color, sort, active) VALUES (?, ?, ?, ?, ?)').run(
        id,
        json(c.name),
        c.color,
        sort,
        c.active ? 1 : 0
      )
    })

    const groupId = new Map<string, string>()
    s.modifierGroups.forEach((g, sort) => {
      const id = newId()
      groupId.set(g.code, id)
      db.prepare('INSERT INTO modifier_groups (id, name_json, min_select, max_select, sort) VALUES (?, ?, ?, ?, ?)').run(
        id,
        json(g.name),
        g.min_select,
        g.max_select,
        sort
      )
      g.modifiers.forEach((m, msort) => {
        db.prepare('INSERT INTO modifiers (id, group_id, name_json, price_delta_cents, sort) VALUES (?, ?, ?, ?, ?)').run(
          newId(),
          id,
          json(m.name),
          m.price_delta_cents,
          msort
        )
      })
    })

    const productId = new Map<string, string>()
    s.products.forEach((p, sort) => {
      const id = newId()
      productId.set(p.code, id)
      db.prepare(
        `INSERT INTO products (id, category_id, name_json, price_cents, vat_bp, barcode, sold_by_weight, color,
                               key_size, sort, active, stock_tracked, stock_milli, low_stock_milli, course)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        categoryId.get(p.category),
        json(p.name),
        p.price_cents,
        p.vat_bp,
        p.barcode ?? null,
        p.sold_by_weight ? 1 : 0,
        p.color ?? null,
        p.key_size,
        sort,
        p.active ? 1 : 0,
        p.stock_tracked ? 1 : 0,
        p.stock_milli,
        p.low_stock_milli,
        p.course
      )
      for (const code of p.modifier_groups) {
        db.prepare('INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?, ?)').run(id, groupId.get(code))
      }
    })

    for (const m of s.menus) {
      const menuId = newId()
      db.prepare('INSERT INTO menus (id, product_id) VALUES (?, ?)').run(menuId, productId.get(m.product))
      m.courses.forEach((course, sort) => {
        const courseId = newId()
        db.prepare('INSERT INTO menu_courses (id, menu_id, name_json, sort, choose_count) VALUES (?, ?, ?, ?, ?)').run(
          courseId,
          menuId,
          json(course.name),
          sort,
          course.choose_count
        )
        for (const item of course.items) {
          db.prepare('INSERT INTO menu_course_items (course_id, product_id, supplement_cents) VALUES (?, ?, ?)').run(
            courseId,
            productId.get(item.product),
            item.supplement_cents
          )
        }
      })
    }

    const roomId = new Map<string, string>()
    s.rooms.forEach((r, sort) => {
      const id = newId()
      roomId.set(r.code, id)
      db.prepare('INSERT INTO rooms (id, name_json, sort) VALUES (?, ?, ?)').run(id, json(r.name), sort)
    })
    for (const x of s.tables) {
      db.prepare('INSERT INTO tables (id, room_id, label, shape, x, y, w, h, seats, active) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        newId(),
        roomId.get(x.room),
        x.label,
        x.shape,
        x.x,
        x.y,
        x.w,
        x.h,
        x.seats,
        x.active ? 1 : 0
      )
    }

    s.paymentMethods.forEach((m, sort) => {
      db.prepare('INSERT INTO payment_methods (id, code, name_json, opens_drawer, active, sort) VALUES (?, ?, ?, ?, ?, ?)').run(
        newId(),
        m.code,
        json(m.name),
        m.opens_drawer ? 1 : 0,
        m.active ? 1 : 0,
        sort
      )
    })

    for (const p of s.profiles) {
      db.prepare('INSERT INTO profiles (id, name_json, permissions_json, max_discount_bp) VALUES (?, ?, ?, ?)').run(
        newId(),
        json(p.name),
        json(p.permissions),
        p.max_discount_bp
      )
    }

    const printerId = new Map<string, string>()
    for (const p of s.printers ?? []) {
      const id = newId()
      printerId.set(p.code, id)
      db.prepare(
        'INSERT INTO printers (id, name, kind, address, width_mm, lang, raster, role, active) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(id, p.name, p.kind, p.address ?? '', p.width_mm, p.lang, p.raster ? 1 : 0, p.role, p.active ? 1 : 0)
    }
    for (const [category, printers] of Object.entries(s.routing ?? {})) {
      for (const code of printers) {
        db.prepare('INSERT INTO category_printers (category_id, printer_id) VALUES (?, ?)').run(
          categoryId.get(category),
          printerId.get(code)
        )
      }
    }
  })()
}
