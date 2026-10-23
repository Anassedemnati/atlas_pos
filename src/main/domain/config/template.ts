import { z } from 'zod'
import { MODULES } from '@shared/modules'
import { PERMISSIONS } from '@shared/permissions'
import bakery from '../../../../resources/templates/bakery.json'
import cafe from '../../../../resources/templates/cafe.json'
import restaurant from '../../../../resources/templates/restaurant.json'
import retail from '../../../../resources/templates/retail.json'
import { BUSINESS_TYPES, SETTINGS, portableSettingsSchema, type BusinessType } from './settings-registry'

// File conventions: container keys are camelCase (`paymentMethods`, `modifierGroups`); the fields
// of an item mirror its database column (`price_cents`, `vat_bp`, `sold_by_weight`). A `code` is a
// template-local, kebab-case identifier: other items refer to it, and it names the product image
// files. Array order is display order (it becomes `sort`). Prices are TTC, in centimes.

const text = z.string().trim().min(1)

/** Template-local identifier: lower-case, digits, `-` (and `_`) between them. */
export const CodeSchema = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/)

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

/** French is the reference copy and always present; Arabic and English are optional. */
export const LocalizedNameSchema = z.strictObject({ fr: text, ar: text.optional(), en: text.optional() })

export const CategorySchema = z.strictObject({
  code: CodeSchema,
  name: LocalizedNameSchema,
  color: Color,
  active: z.boolean().default(true)
})

/** A product as the database holds it: no image (images are files, only templates reference them). */
export const CatalogProductSchema = z.strictObject({
  code: CodeSchema,
  category: CodeSchema,
  name: LocalizedNameSchema,
  price_cents: z.number().int().min(0),
  /** Basis points: 2000 = 20 %. */
  vat_bp: z.number().int().min(0).max(10000),
  /** EAN-8, UPC-A, EAN-13 or GTIN-14, digits only. */
  barcode: z.string().regex(/^\d{8,14}$/).optional(),
  /** `price_cents` is then the price per kilogram. */
  sold_by_weight: z.boolean().default(false),
  color: Color.optional(),
  key_size: z.number().int().positive().default(1),
  /** 0 = no course (sent at once), then 1, 2, 3... for "send next course". */
  course: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  stock_tracked: z.boolean().default(false),
  /** Milli-units: 1 item = 1000. */
  stock_milli: z.number().int().min(0).default(0),
  low_stock_milli: z.number().int().min(0).default(0),
  modifier_groups: z.array(CodeSchema).default([])
})

/** A template product may be flagged to get an illustration (`media/<template>/<code>.webp`). */
export const TemplateProductSchema = CatalogProductSchema.extend({ image: z.boolean().default(false) })

export const ModifierGroupSchema = z
  .strictObject({
    code: CodeSchema,
    name: LocalizedNameSchema,
    min_select: z.number().int().min(0).default(0),
    max_select: z.number().int().min(1).default(1),
    modifiers: z
      .array(z.strictObject({ name: LocalizedNameSchema, price_delta_cents: z.number().int().default(0) }))
      .min(1)
  })
  .refine((g) => g.min_select <= g.max_select, { message: 'min_select is greater than max_select', path: ['min_select'] })

/** A set menu: the menu itself is a product (it carries the price), its courses offer choices. */
export const MenuSchema = z.strictObject({
  product: CodeSchema,
  courses: z
    .array(
      z.strictObject({
        name: LocalizedNameSchema,
        choose_count: z.number().int().min(1).default(1),
        items: z
          .array(z.strictObject({ product: CodeSchema, supplement_cents: z.number().int().min(0).default(0) }))
          .min(1)
      })
    )
    .min(1)
})

export const RoomSchema = z.strictObject({ code: CodeSchema, name: LocalizedNameSchema })

/** Position and size on the room's logical grid (a room is laid out on 1000 x 600). */
export const TableSchema = z.strictObject({
  room: CodeSchema,
  label: text,
  shape: z.enum(['square', 'round', 'rect']),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  seats: z.number().int().min(1),
  active: z.boolean().default(true)
})

export const PaymentMethodSchema = z.strictObject({
  code: CodeSchema,
  name: LocalizedNameSchema,
  opens_drawer: z.boolean().default(false),
  active: z.boolean().default(true)
})

/** A permission profile ("Gérant", "Caissier"...): the named permissions users are given. */
export const PermissionProfileSchema = z.strictObject({
  code: CodeSchema,
  name: LocalizedNameSchema,
  permissions: z
    .array(z.enum(PERMISSIONS))
    .refine((list) => new Set(list).size === list.length, { message: 'duplicate permission' }),
  /** Largest discount without a manager PIN, in basis points (1000 = 10 %). */
  max_discount_bp: z.number().int().min(0).max(10000)
})

export type Category = z.output<typeof CategorySchema>
export type CatalogProduct = z.output<typeof CatalogProductSchema>
export type TemplateProduct = z.output<typeof TemplateProductSchema>
export type ModifierGroup = z.output<typeof ModifierGroupSchema>
export type Menu = z.output<typeof MenuSchema>
export type Room = z.output<typeof RoomSchema>
export type TableDef = z.output<typeof TableSchema>
export type PaymentMethodDef = z.output<typeof PaymentMethodSchema>
export type PermissionProfile = z.output<typeof PermissionProfileSchema>

/** The sections that must agree with each other, whether they come from a template or a profile. */
export interface Sections {
  categories: Category[]
  products: CatalogProduct[]
  modifierGroups: ModifierGroup[]
  menus: Menu[]
  rooms: Room[]
  tables: TableDef[]
  paymentMethods: PaymentMethodDef[]
  profiles: PermissionProfile[]
}

export interface IntegrityIssue {
  /** Starts with the section name (`products`, `tables`...), as if every section were top-level. */
  path: (string | number)[]
  message: string
}

/** Unique codes, unique barcodes, and every reference (category, group, product, room) resolves. */
export function integrityIssues(s: Sections): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ path, message })
  }

  const uniqueCodes = (section: keyof Sections, items: { code: string }[]): void => {
    const seen = new Set<string>()
    items.forEach((item, i) => {
      if (seen.has(item.code)) add([section, i, 'code'], `duplicate code "${item.code}"`)
      seen.add(item.code)
    })
  }
  uniqueCodes('categories', s.categories)
  uniqueCodes('products', s.products)
  uniqueCodes('modifierGroups', s.modifierGroups)
  uniqueCodes('rooms', s.rooms)
  uniqueCodes('paymentMethods', s.paymentMethods)
  uniqueCodes('profiles', s.profiles)

  const categories = new Set(s.categories.map((c) => c.code))
  const groups = new Set(s.modifierGroups.map((g) => g.code))
  const products = new Set(s.products.map((p) => p.code))
  const rooms = new Set(s.rooms.map((r) => r.code))

  const barcodes = new Set<string>()
  s.products.forEach((p, i) => {
    if (!categories.has(p.category)) add(['products', i, 'category'], `unknown category "${p.category}"`)
    p.modifier_groups.forEach((g, j) => {
      if (!groups.has(g)) add(['products', i, 'modifier_groups', j], `unknown modifier group "${g}"`)
    })
    if (p.barcode !== undefined) {
      if (barcodes.has(p.barcode)) add(['products', i, 'barcode'], `duplicate barcode "${p.barcode}"`)
      barcodes.add(p.barcode)
    }
  })

  const menuProducts = new Set<string>()
  s.menus.forEach((m, i) => {
    if (!products.has(m.product)) add(['menus', i, 'product'], `unknown product "${m.product}"`)
    if (menuProducts.has(m.product)) add(['menus', i, 'product'], `a second menu for "${m.product}"`)
    menuProducts.add(m.product)
    m.courses.forEach((course, j) =>
      course.items.forEach((item, k) => {
        if (!products.has(item.product)) {
          add(['menus', i, 'courses', j, 'items', k, 'product'], `unknown product "${item.product}"`)
        }
      })
    )
  })

  const labels = new Set<string>()
  s.tables.forEach((t, i) => {
    if (!rooms.has(t.room)) add(['tables', i, 'room'], `unknown room "${t.room}"`)
    const key = `${t.room}\u0000${t.label}`
    if (labels.has(key)) add(['tables', i, 'label'], `duplicate table "${t.label}" in room "${t.room}"`)
    labels.add(key)
  })

  return issues
}

export const TemplateSchema = z
  .strictObject({
    id: z.enum(BUSINESS_TYPES),
    version: z.number().int().positive(),
    modules: SETTINGS.modules.schema,
    settings: portableSettingsSchema,
    paymentMethods: z.array(PaymentMethodSchema),
    profiles: z.array(PermissionProfileSchema),
    categories: z.array(CategorySchema),
    products: z.array(TemplateProductSchema),
    modifierGroups: z.array(ModifierGroupSchema),
    menus: z.array(MenuSchema),
    rooms: z.array(RoomSchema),
    tables: z.array(TableSchema),
    /** Category code -> the printer role that prints its lines. */
    printersRouting: z.record(CodeSchema, z.enum(['kitchen', 'bar']))
  })
  .superRefine((t, ctx) => {
    for (const issue of integrityIssues(t)) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
    const categories = new Set(t.categories.map((c) => c.code))
    for (const code of Object.keys(t.printersRouting)) {
      if (!categories.has(code)) {
        ctx.addIssue({ code: 'custom', message: `route for unknown category "${code}"`, path: ['printersRouting', code] })
      }
    }
  })

export type Template = z.output<typeof TemplateSchema>

export const TEMPLATE_IDS = BUSINESS_TYPES

// Bundled with the main process (like the SQL migrations) instead of read from disk: electron-builder
// only ships `out/` and `package.json`.
const SOURCES: Record<BusinessType, unknown> = { restaurant, cafe, bakery, retail }

/** Reads `resources/templates/<id>.json` and validates it. Always a fresh object, free to modify. */
export function loadTemplate(id: BusinessType): Template {
  if (!Object.hasOwn(SOURCES, id)) throw new Error(`unknown template "${id}"`)
  return TemplateSchema.parse(SOURCES[id])
}
