import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import type { Result } from '@shared/result'
import { version as PACKAGE_VERSION } from '../../../../package.json'
import { AppErrorException } from '../../application/errors'
import type { Clock } from '../../application/ports'
import {
  SETTINGS,
  isPortableSettingKey,
  portableSettingsSchema
} from '../../domain/config/settings-registry'
import {
  CatalogProductSchema,
  CategorySchema,
  CodeSchema,
  LocalizedNameSchema,
  MenuSchema,
  ModifierGroupSchema,
  PaymentMethodSchema,
  PermissionProfileSchema,
  RoomSchema,
  TableSchema,
  integrityIssues,
  type CatalogProduct,
  type Category,
  type Menu,
  type ModifierGroup,
  type PaymentMethodDef,
  type PermissionProfile,
  type Room,
  type TableDef
} from '../../domain/config/template'
import type { Database } from '../db/connection'
import { createSettingsRepo } from '../db/repos/settings-repo'

// A setup profile (`.atlasprofile`) is the shareable part of a finished setup: gzip of one JSON
// document. It never carries users, PINs, passwords, customers, sales, the technician code, files
// (logo, product photos) or machine-specific device paths. Catalogue items refer to each other by
// `code`, as in the templates. The database has no codes, so export derives them from the French
// names; the same names give the same codes on every machine, which makes a profile stable
// across export -> import -> export.

export const PROFILE_FORMAT = 'atlasprofile'
/** Bump when the document structure changes in a way an older reader cannot understand. */
export const PROFILE_SCHEMA_VERSION = 1

/** Decompressed size limit: a real profile is a few hundred KB, this stops a gzip bomb. */
const MAX_JSON_BYTES = 32 * 1024 * 1024

/** Printer kinds whose `address` is a network address worth keeping; every other kind's address is a local device. */
const KINDS_WITH_PORTABLE_ADDRESS: readonly string[] = ['network']

export const PrinterSchema = z.strictObject({
  code: CodeSchema,
  name: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  /** Absent for USB, serial and OS printers: the device path belongs to the machine. */
  address: z.string().optional(),
  width_mm: z.number().int().positive(),
  lang: z.enum(['fr', 'ar', 'en']),
  raster: z.boolean(),
  role: z.string().trim().min(1),
  active: z.boolean()
})
export type PrinterDef = z.output<typeof PrinterSchema>

const CATALOG_SECTIONS = new Set(['categories', 'products', 'modifierGroups', 'menus'])

export const ProfileSchema = z
  .strictObject({
    format: z.literal(PROFILE_FORMAT),
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    appVersion: z.string().min(1),
    /** Stored settings, minus `tech.codeHash`, the logo path and `modules` (its own section). */
    settings: portableSettingsSchema,
    modules: SETTINGS.modules.schema,
    catalog: z.strictObject({
      categories: z.array(CategorySchema),
      products: z.array(CatalogProductSchema),
      modifierGroups: z.array(ModifierGroupSchema),
      menus: z.array(MenuSchema)
    }),
    rooms: z.array(RoomSchema),
    tables: z.array(TableSchema),
    printers: z.array(PrinterSchema),
    /** Category code -> codes of the printers that print its lines. */
    routing: z.record(CodeSchema, z.array(CodeSchema).min(1)),
    paymentMethods: z.array(PaymentMethodSchema),
    profiles: z.array(PermissionProfileSchema)
  })
  .superRefine((p, ctx) => {
    p.printers.forEach((printer, i) => {
      // A hand-edited profile must not be able to point this machine at a device path.
      if (printer.address !== undefined && !KINDS_WITH_PORTABLE_ADDRESS.includes(printer.kind)) {
        ctx.addIssue({ code: 'custom', message: 'only a network printer carries an address', path: ['printers', i, 'address'] })
      }
    })
    const { rooms, tables, paymentMethods, profiles } = p
    for (const { path, message } of integrityIssues({ ...p.catalog, rooms, tables, paymentMethods, profiles })) {
      const section = String(path[0])
      ctx.addIssue({ code: 'custom', message, path: CATALOG_SECTIONS.has(section) ? ['catalog', ...path] : path })
    }
    const printers = new Set<string>()
    p.printers.forEach((printer, i) => {
      if (printers.has(printer.code)) {
        ctx.addIssue({ code: 'custom', message: `duplicate code "${printer.code}"`, path: ['printers', i, 'code'] })
      }
      printers.add(printer.code)
    })
    const categories = new Set(p.catalog.categories.map((c) => c.code))
    for (const [category, codes] of Object.entries(p.routing)) {
      if (!categories.has(category)) {
        ctx.addIssue({ code: 'custom', message: `route for unknown category "${category}"`, path: ['routing', category] })
      }
      codes.forEach((code, i) => {
        if (!printers.has(code)) {
          ctx.addIssue({ code: 'custom', message: `unknown printer "${code}"`, path: ['routing', category, i] })
        }
      })
    }
  })

export type Profile = z.output<typeof ProfileSchema>

// Export -------------------------------------------------------------------------------------------

export const slug = (text: string): string =>
  text
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item'

/** One code per name, in order: the slug, then `-2`, `-3`... for repeated names. */
function codesFor(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const base = slug(name)
    let code = base
    for (let n = 2; used.has(code); n++) code = `${base}-${n}`
    used.add(code)
    return code
  })
}

type LocalizedName = z.output<typeof LocalizedNameSchema>

const exportFailed = (field: string, reason: string): AppErrorException =>
  new AppErrorException('profile_export_failed', { field, reason })

function parseJson(json: string, field: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    throw exportFailed(field, 'not JSON')
  }
}

/** A stored name; an empty or blank Arabic or English name is the same as none. `field` names the column in errors. */
function nameOf(json: string, field: string): LocalizedName {
  const raw = parseJson(json, field)
  const { fr, ar, en } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
  const parsed = LocalizedNameSchema.safeParse({ fr, ...(filled(ar) ? { ar } : {}), ...(filled(en) ? { en } : {}) })
  if (!parsed.success) throw exportFailed(field, parsed.error.issues[0]?.message ?? 'invalid name')
  return parsed.data
}

const namesOf = (rows: Row[], field: string): LocalizedName[] =>
  rows.map((r) => nameOf(r['name_json'] as string, field))

/** Keeps a payment method code that already is a code, slugs the others, and keeps all of them unique. */
function paymentCodes(codes: string[]): string[] {
  const used = new Set(codes.filter((code) => CodeSchema.safeParse(code).success))
  return codes.map((code) => {
    if (CodeSchema.safeParse(code).success) return code
    const base = slug(code)
    let unique = base
    for (let n = 2; used.has(unique); n++) unique = `${base}-${n}`
    used.add(unique)
    return unique
  })
}

interface Row {
  [column: string]: string | number | null
}
const all = (db: Database, sql: string): Row[] => db.prepare(sql).all() as Row[]

/** Group rows by one of their columns, keeping row order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

// Every query has an explicit ORDER BY: array order is display order, and codes depend on it.
function buildProfile(db: Database, createdAt: string, appVersion: string): Profile {
  const settingsRepo = createSettingsRepo(db)

  const settings: Record<string, unknown> = {}
  for (const { key } of all(db, 'SELECT key FROM settings ORDER BY key') as { key: string }[]) {
    if (isPortableSettingKey(key)) settings[key] = settingsRepo.get(key)
  }

  // Categories and products
  const categoryRows = all(db, 'SELECT * FROM categories ORDER BY sort, id')
  const categoryNames = namesOf(categoryRows, 'categories.name')
  const categoryCodes = codesFor(categoryNames.map((n) => n.fr))
  const categoryCode = new Map(categoryRows.map((r, i) => [r['id'] as string, categoryCodes[i]!]))
  const categories: Category[] = categoryRows.map((r, i) => ({
    code: categoryCodes[i]!,
    name: categoryNames[i]!,
    color: r['color'] as string,
    active: r['active'] === 1
  }))

  const groupRows = all(db, 'SELECT * FROM modifier_groups ORDER BY sort, id')
  const groupNames = namesOf(groupRows, 'modifierGroups.name')
  const groupCodes = codesFor(groupNames.map((n) => n.fr))
  const groupCode = new Map(groupRows.map((r, i) => [r['id'] as string, groupCodes[i]!]))
  const modifiersByGroup = groupBy(all(db, 'SELECT * FROM modifiers ORDER BY sort, id'), (r) => r['group_id'] as string)
  const modifierGroups: ModifierGroup[] = groupRows.map((r, i) => ({
    code: groupCodes[i]!,
    name: groupNames[i]!,
    min_select: r['min_select'] as number,
    max_select: r['max_select'] as number,
    modifiers: (modifiersByGroup.get(r['id'] as string) ?? []).map((m) => ({
      name: nameOf(m['name_json'] as string, 'modifierGroups.modifiers.name'),
      price_delta_cents: m['price_delta_cents'] as number
    }))
  }))

  const linked = new Map<string, Set<string>>()
  for (const link of all(db, 'SELECT product_id, group_id FROM product_modifier_groups')) {
    const set = linked.get(link['product_id'] as string) ?? new Set<string>()
    set.add(link['group_id'] as string)
    linked.set(link['product_id'] as string, set)
  }

  const productRows = all(
    db,
    `SELECT p.* FROM products p JOIN categories c ON c.id = p.category_id
     ORDER BY c.sort, c.id, p.sort, p.id`
  )
  const productNames = namesOf(productRows, 'products.name')
  const productCodes = codesFor(productNames.map((n) => n.fr))
  const productCode = new Map(productRows.map((r, i) => [r['id'] as string, productCodes[i]!]))
  const products: CatalogProduct[] = productRows.map((r, i) => ({
    code: productCodes[i]!,
    category: categoryCode.get(r['category_id'] as string)!,
    name: productNames[i]!,
    price_cents: r['price_cents'] as number,
    vat_bp: r['vat_bp'] as number,
    ...(r['barcode'] === null ? {} : { barcode: r['barcode'] as string }),
    sold_by_weight: r['sold_by_weight'] === 1,
    ...(r['color'] === null ? {} : { color: r['color'] as string }),
    key_size: r['key_size'] as number,
    course: r['course'] as number,
    active: r['active'] === 1,
    stock_tracked: r['stock_tracked'] === 1,
    // A profile is a setup, not an inventory: tracking and the alert threshold travel, the live
    // quantity (which can even be negative after overselling) does not.
    stock_milli: 0,
    low_stock_milli: r['low_stock_milli'] as number,
    modifier_groups: groupRows
      .filter((g) => linked.get(r['id'] as string)?.has(g['id'] as string))
      .map((g) => groupCode.get(g['id'] as string)!)
  }))

  // Set menus
  const coursesByMenu = groupBy(all(db, 'SELECT * FROM menu_courses ORDER BY sort, id'), (r) => r['menu_id'] as string)
  const itemsByCourse = groupBy(all(db, 'SELECT * FROM menu_course_items ORDER BY rowid'), (r) => r['course_id'] as string)
  const menus: Menu[] = all(db, 'SELECT * FROM menus ORDER BY id').map((m) => ({
    product: productCode.get(m['product_id'] as string)!,
    courses: (coursesByMenu.get(m['id'] as string) ?? []).map((c) => ({
      name: nameOf(c['name_json'] as string, 'menus.courses.name'),
      choose_count: c['choose_count'] as number,
      items: (itemsByCourse.get(c['id'] as string) ?? []).map((i) => ({
        product: productCode.get(i['product_id'] as string)!,
        supplement_cents: i['supplement_cents'] as number
      }))
    }))
  }))

  // Floor plan
  const roomRows = all(db, 'SELECT * FROM rooms ORDER BY sort, id')
  const roomNames = namesOf(roomRows, 'rooms.name')
  const roomCodes = codesFor(roomNames.map((n) => n.fr))
  const roomCode = new Map(roomRows.map((r, i) => [r['id'] as string, roomCodes[i]!]))
  const rooms: Room[] = roomRows.map((_, i) => ({ code: roomCodes[i]!, name: roomNames[i]! }))
  const tables: TableDef[] = all(
    db,
    `SELECT t.* FROM tables t JOIN rooms r ON r.id = t.room_id ORDER BY r.sort, r.id, t.id`
  ).map((t) => ({
    room: roomCode.get(t['room_id'] as string)!,
    label: t['label'] as string,
    shape: t['shape'] as TableDef['shape'],
    // The grid starts at 0: a position dragged off its edge is brought back onto it.
    x: Math.max(0, t['x'] as number),
    y: Math.max(0, t['y'] as number),
    w: t['w'] as number,
    h: t['h'] as number,
    seats: t['seats'] as number,
    active: t['active'] === 1
  }))

  // Printers and routing
  const printerRows = all(db, 'SELECT * FROM printers ORDER BY id')
  const printerCodes = codesFor(printerRows.map((r) => r['name'] as string))
  const printers: PrinterDef[] = printerRows.map((r, i) => ({
    code: printerCodes[i]!,
    name: r['name'] as string,
    kind: r['kind'] as string,
    ...(KINDS_WITH_PORTABLE_ADDRESS.includes(r['kind'] as string) ? { address: r['address'] as string } : {}),
    width_mm: r['width_mm'] as number,
    lang: r['lang'] as PrinterDef['lang'],
    raster: r['raster'] === 1,
    role: r['role'] as string,
    active: r['active'] === 1
  }))
  const routed = new Set(
    all(db, 'SELECT category_id, printer_id FROM category_printers').map((r) => `${r['category_id']}|${r['printer_id']}`)
  )
  const routing: Record<string, string[]> = {}
  categoryRows.forEach((c, ci) => {
    const codes = printerRows
      .map((p, pi) => (routed.has(`${c['id']}|${p['id']}`) ? printerCodes[pi]! : null))
      .filter((code): code is string => code !== null)
    if (codes.length > 0) routing[categoryCodes[ci]!] = codes
  })

  // Payment methods and permission profiles (the people themselves are never exported)
  const paymentRows = all(db, 'SELECT * FROM payment_methods ORDER BY sort, id')
  const paymentMethodCodes = paymentCodes(paymentRows.map((m) => m['code'] as string))
  const paymentNames = namesOf(paymentRows, 'paymentMethods.name')
  const paymentMethods: PaymentMethodDef[] = paymentRows.map((m, i) => ({
    code: paymentMethodCodes[i]!,
    name: paymentNames[i]!,
    opens_drawer: m['opens_drawer'] === 1,
    active: m['active'] === 1
  }))
  const profileRows = all(db, 'SELECT * FROM profiles ORDER BY id')
  const profileNames = namesOf(profileRows, 'profiles.name')
  const profileCodes = codesFor(profileNames.map((n) => n.fr))
  const profiles: PermissionProfile[] = profileRows.map((r, i) => ({
    code: profileCodes[i]!,
    name: profileNames[i]!,
    permissions: parseJson(r['permissions_json'] as string, 'profiles.permissions') as PermissionProfile['permissions'],
    max_discount_bp: r['max_discount_bp'] as number
  }))

  const built = ProfileSchema.safeParse({
    format: PROFILE_FORMAT,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    createdAt,
    appVersion,
    settings,
    modules: settingsRepo.get('modules'),
    catalog: { categories, products, modifierGroups, menus },
    rooms,
    tables,
    printers,
    routing,
    paymentMethods,
    profiles
  })
  if (!built.success) {
    const issue = built.error.issues[0]
    throw exportFailed((issue?.path ?? []).join('.'), issue?.message ?? 'invalid profile')
  }
  return built.data
}

export interface ExportOptions {
  /** Stamps `createdAt`. Defaults to the system clock. */
  clock?: Clock
  /** Defaults to the version in package.json. */
  appVersion?: string
}

/**
 * The current setup as a `.atlasprofile`: gzip of the JSON `Profile`. Read in one transaction, so
 * the profile is a consistent snapshot even while the till writes.
 *
 * Normalised on the way out, so that legal rows never block an export: live stock is not exported
 * (`stock_milli` is 0), an empty Arabic or English name is dropped, a negative table position is
 * clamped to 0 and a payment method code that is not a code is slugged. Whatever a profile still
 * cannot express throws `AppErrorException('profile_export_failed', { field, reason })`: it never
 * writes a file `readProfile` would refuse, and never leaks a raw ZodError.
 */
export function exportProfile(db: Database, options: ExportOptions = {}): Buffer {
  const now = (options.clock ?? { now: () => new Date() }).now()
  const profile = db.transaction(() => buildProfile(db, now.toISOString(), options.appVersion ?? PACKAGE_VERSION))()
  return gzipSync(Buffer.from(JSON.stringify(profile), 'utf8'))
}

// Import -------------------------------------------------------------------------------------------

const fail = (code: string, params?: Record<string, unknown>): Result<never> => ({
  ok: false,
  error: { code, messageKey: `errors.${code}`, ...(params ? { params } : {}) }
})

// Enough to tell a profile of this app from any other file, and its version, before anything else
// is judged: a newer profile may well have a structure this reader does not know.
const Envelope = z.looseObject({ format: z.literal(PROFILE_FORMAT), schemaVersion: z.number().int().min(1) })

/**
 * Decompresses and validates a `.atlasprofile`. Errors:
 * - `invalid_profile`: not a gzip, too large, not JSON, not a profile, or a field is wrong
 *   (`params.field` is the path, `params.reason` the reason);
 * - `profile_newer_version`: written by a newer app (`schemaVersion` greater than 1).
 * Older versions will be upgraded here when a version 2 exists.
 */
export function readProfile(buf: Buffer): Result<Profile> {
  let text: string
  try {
    text = gunzipSync(buf, { maxOutputLength: MAX_JSON_BYTES }).toString('utf8')
  } catch (error) {
    const tooLarge = (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    return fail('invalid_profile', { reason: tooLarge ? 'too_large' : 'not_gzip' })
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return fail('invalid_profile', { reason: 'not_json' })
  }

  const envelope = Envelope.safeParse(json)
  if (!envelope.success) return fail('invalid_profile', { reason: 'not_a_profile' })
  if (envelope.data.schemaVersion > PROFILE_SCHEMA_VERSION) {
    return fail('profile_newer_version', { found: envelope.data.schemaVersion, supported: PROFILE_SCHEMA_VERSION })
  }

  const parsed = ProfileSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail('invalid_profile', { field: (issue?.path ?? []).join('.'), reason: issue?.message })
  }
  return { ok: true, value: parsed.data }
}
