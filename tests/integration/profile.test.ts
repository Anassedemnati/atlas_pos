import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { AppErrorException } from '../../src/main/application/errors'
import { createEventBus } from '../../src/main/application/events'
import { loadTemplate } from '../../src/main/domain/config/template'
import type { Template } from '../../src/main/domain/config/template'
import type { SettingKey } from '../../src/main/domain/config/settings-registry'
import type { Database } from '../../src/main/infrastructure/db/connection'
import { createSettingsRepo } from '../../src/main/infrastructure/db/repos/settings-repo'
import { createUnitOfWork } from '../../src/main/infrastructure/db/uow'
import {
  exportProfile,
  readProfile,
  type PrinterDef,
  type Profile
} from '../../src/main/infrastructure/profile/profile-io'
import { fixedClock } from '../helpers/clock'
import { tempDb, type TempDb } from '../helpers/db'
import { seedSetup } from '../helpers/seed-setup'

const legal = {
  raisonSociale: 'Café Atlas SARL',
  nomCommercial: 'Café Atlas',
  adresse: '12 avenue Hassan II',
  ville: 'Casablanca',
  telephone: '0522000000',
  ice: '001234567000012',
  if: '12345678',
  rc: '123456',
  patente: '31234567'
}

const printers: PrinterDef[] = [
  { code: 'p1', name: 'Ticket USB', kind: 'device-file', address: '/dev/usb/lp0', width_mm: 80, lang: 'fr', raster: false, role: 'receipt', active: true },
  { code: 'p2', name: 'Cuisine', kind: 'network', address: '192.168.1.50:9100', width_mm: 80, lang: 'fr', raster: false, role: 'kitchen', active: true },
  { code: 'p3', name: 'Bar', kind: 'network', address: '192.168.1.51:9100', width_mm: 58, lang: 'ar', raster: true, role: 'bar', active: true },
  { code: 'p4', name: 'Ticket Windows', kind: 'windows-raw', address: 'EPSON TM-T20', width_mm: 80, lang: 'fr', raster: false, role: 'receipt', active: false },
  { code: 'p5', name: 'Port série', kind: 'serial', address: 'COM3', width_mm: 80, lang: 'fr', raster: false, role: 'receipt', active: true },
  { code: 'p6', name: 'PDF', kind: 'os-html', address: 'Microsoft Print to PDF', width_mm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }
]

const DRINKS = new Set(['boissons-chaudes', 'boissons-fraiches', 'jus'])

/** A finished restaurant setup, plus everything that must never leave the machine. */
function installRestaurant(db: Database, template: Template): void {
  const routing = Object.fromEntries(
    template.categories.map((c) => [c.code, [DRINKS.has(c.code) ? 'p3' : 'p2']])
  )
  seedSetup(db, { ...template, printers, routing })

  const uow = createUnitOfWork(db, fixedClock(), createEventBus())
  const repo = createSettingsRepo(db)
  uow.run((tx) => {
    repo.set(tx, 'business.type', 'restaurant')
    repo.set(tx, 'business.legal', legal)
    repo.set(tx, 'business.logo', 'media/logo.png')
    repo.set(tx, 'modules', template.modules)
    repo.set(tx, 'receipt.footer', 'Merci et à bientôt !')
    repo.set(tx, 'discount.reasons', ['Fidélité'])
    repo.set(tx, 'tech.codeHash', 'scrypt$TECH-CODE-SENTINEL')
  })

  const profileId = (db.prepare('SELECT id FROM profiles LIMIT 1').get() as { id: string }).id
  db.prepare(
    `INSERT INTO users (id, display_name, pin_hash, username, password_hash, profile_id, created_at)
     VALUES ('u1', 'Karim', 'scrypt$PIN-SENTINEL', 'karim', 'scrypt$PASSWORD-SENTINEL', ?, 'x')`
  ).run(profileId)
  db.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'Client Secret SARL', '0600000000', 'x')").run()
  db.prepare("INSERT INTO business_days (id, number, opened_at) VALUES ('d1', 1, 'x')").run()
  db.prepare(
    "INSERT INTO orders (id, day_id, type, user_id, opened_at, updated_at, note) VALUES ('o1', 'd1', 'dine_in', 'u1', 'x', 'x', 'ORDER-NOTE-SENTINEL')"
  ).run()
}

const unzip = (buf: Buffer): string => gunzipSync(buf).toString('utf8')
const asProfile = (buf: Buffer): Profile => {
  const result = readProfile(buf)
  if (!result.ok) throw new Error(`readProfile failed: ${JSON.stringify(result.error)}`)
  return result.value
}
const gz = (value: unknown): Buffer => gzipSync(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
const errorOf = (buf: Buffer): { code: string; messageKey: string; params?: Record<string, unknown> } => {
  const result = readProfile(buf)
  if (result.ok) throw new Error('expected readProfile to fail')
  return result.error
}

describe('setup profile (.atlasprofile)', () => {
  let t: TempDb
  let restaurant: Template
  beforeEach(() => {
    t = tempDb()
    restaurant = loadTemplate('restaurant')
  })
  afterEach(() => t.cleanup())

  describe('exportProfile', () => {
    it('is a gzip of JSON with the documented envelope and sections, in order', () => {
      installRestaurant(t.db, restaurant)
      const buf = exportProfile(t.db, { clock: fixedClock('2026-10-23T08:00:00.000Z'), appVersion: '1.2.3' })
      expect([buf[0], buf[1]]).toEqual([0x1f, 0x8b]) // gzip magic
      const json = JSON.parse(unzip(buf)) as Record<string, unknown>
      expect(Object.keys(json)).toEqual([
        'format',
        'schemaVersion',
        'createdAt',
        'appVersion',
        'settings',
        'modules',
        'catalog',
        'rooms',
        'tables',
        'printers',
        'routing',
        'paymentMethods',
        'profiles'
      ])
      expect(json['format']).toBe('atlasprofile')
      expect(json['schemaVersion']).toBe(1)
      expect(json['createdAt']).toBe('2026-10-23T08:00:00.000Z')
      expect(json['appVersion']).toBe('1.2.3')
    })

    it('works with the db alone: the clock is real and the version is the package version', () => {
      const before = Date.now()
      const profile = asProfile(exportProfile(t.db))
      expect(profile.appVersion).toBe(pkg.version)
      expect(Date.parse(profile.createdAt)).toBeGreaterThanOrEqual(before - 1000)
      expect(Date.parse(profile.createdAt)).toBeLessThanOrEqual(Date.now() + 1000)
    })

    it('never contains users, PINs, passwords, the technician code, customers or sales', () => {
      installRestaurant(t.db, restaurant)
      const text = unzip(exportProfile(t.db))
      for (const forbidden of [
        'pin_hash',
        'password_hash',
        'codeHash',
        'PIN-SENTINEL',
        'PASSWORD-SENTINEL',
        'TECH-CODE-SENTINEL',
        'Karim',
        'karim',
        'Client Secret',
        '0600000000',
        'ORDER-NOTE-SENTINEL'
      ]) {
        expect(text, forbidden).not.toContain(forbidden)
      }
    })

    it('carries the stored settings, but not the secret, the logo path or the modules twice', () => {
      installRestaurant(t.db, restaurant)
      const profile = asProfile(exportProfile(t.db))
      expect(profile.settings).toEqual({
        'business.type': 'restaurant',
        'business.legal': legal,
        'receipt.footer': 'Merci et à bientôt !',
        'discount.reasons': ['Fidélité']
      })
      expect(profile.modules).toEqual(restaurant.modules)
    })

    it('exports no setting that was never stored, and all-false modules for a blank database', () => {
      const profile = asProfile(exportProfile(t.db))
      expect(profile.settings).toEqual({})
      expect(Object.values(profile.modules).every((on) => on === false)).toBe(true)
      expect(profile.catalog).toEqual({ categories: [], products: [], modifierGroups: [], menus: [] })
      expect(profile.rooms).toEqual([])
      expect(profile.tables).toEqual([])
      expect(profile.printers).toEqual([])
      expect(profile.routing).toEqual({})
      expect(profile.paymentMethods).toEqual([])
      expect(profile.profiles).toEqual([])
    })

    it('keeps a printer address only for network printers', () => {
      installRestaurant(t.db, restaurant)
      const exported = asProfile(exportProfile(t.db)).printers
      const byName = Object.fromEntries(exported.map((p) => [p.name, p]))
      expect(byName['Cuisine']?.address).toBe('192.168.1.50:9100')
      expect(byName['Bar']?.address).toBe('192.168.1.51:9100')
      for (const name of ['Ticket USB', 'Ticket Windows', 'Port série', 'PDF']) {
        expect(byName[name], name).toBeDefined()
        expect(byName[name]).not.toHaveProperty('address')
      }
      expect(byName['Bar']).toMatchObject({ kind: 'network', width_mm: 58, lang: 'ar', raster: true, role: 'bar', active: true })
      expect(byName['Ticket Windows']).toMatchObject({ active: false })
      expect(JSON.stringify(exported)).not.toMatch(/COM3|lp0|EPSON|Microsoft/)
    })

    it('routes categories to printers by code', () => {
      installRestaurant(t.db, restaurant)
      const profile = asProfile(exportProfile(t.db))
      expect(profile.routing['boissons-chaudes']).toEqual(['bar'])
      expect(profile.routing['plats']).toEqual(['cuisine'])
      expect(Object.keys(profile.routing).sort()).toEqual(restaurant.categories.map((c) => c.code).sort())
    })

    it('reproduces the template catalogue, floor plan, payment methods and permission profiles', () => {
      installRestaurant(t.db, restaurant)
      const profile = asProfile(exportProfile(t.db))
      const { catalog } = profile

      expect(catalog.categories.map((c) => c.name)).toEqual(restaurant.categories.map((c) => c.name))
      expect(catalog.categories.map((c) => c.color)).toEqual(restaurant.categories.map((c) => c.color))

      const categoryName = (code: string, from: { code: string; name: { fr: string } }[]): string =>
        from.find((c) => c.code === code)!.name.fr
      expect(catalog.products).toHaveLength(restaurant.products.length)
      catalog.products.forEach((p, i) => {
        const source = restaurant.products[i]!
        expect(p.name).toEqual(source.name)
        expect(p).toMatchObject({
          price_cents: source.price_cents,
          vat_bp: source.vat_bp,
          course: source.course,
          sold_by_weight: source.sold_by_weight
        })
        expect(categoryName(p.category, catalog.categories)).toBe(categoryName(source.category, restaurant.categories))
        expect(p.modifier_groups.map((g) => categoryName(g, catalog.modifierGroups))).toEqual(
          source.modifier_groups.map((g) => categoryName(g, restaurant.modifierGroups))
        )
        expect(p).not.toHaveProperty('image')
      })

      expect(catalog.modifierGroups.map((g) => ({ name: g.name, modifiers: g.modifiers.map((m) => m.name) }))).toEqual(
        restaurant.modifierGroups.map((g) => ({ name: g.name, modifiers: g.modifiers.map((m) => m.name) }))
      )
      expect(catalog.menus).toHaveLength(1)
      expect(catalog.menus[0]!.courses.map((c) => c.name.fr)).toEqual(['Entrée', 'Plat', 'Boisson'])
      expect(catalog.menus[0]!.courses.map((c) => c.items.length)).toEqual(restaurant.menus[0]!.courses.map((c) => c.items.length))

      expect(profile.rooms.map((r) => r.name)).toEqual(restaurant.rooms.map((r) => r.name))
      expect(profile.tables).toHaveLength(20)
      expect(profile.tables.map((x) => [x.label, x.x, x.y, x.w, x.h, x.seats, x.shape])).toEqual(
        restaurant.tables.map((x) => [x.label, x.x, x.y, x.w, x.h, x.seats, x.shape])
      )
      expect(profile.paymentMethods).toEqual(restaurant.paymentMethods)
      expect(profile.profiles).toEqual(restaurant.profiles)
    })

    it('derives readable, unique kebab-case codes from the French names', () => {
      seedSetup(t.db, {
        categories: [
          { code: 'a', name: { fr: 'Pâtisserie marocaine' }, color: '#112233', active: true },
          { code: 'b', name: { fr: 'Pâtisserie marocaine' }, color: '#112233', active: true },
          { code: 'c', name: { fr: '!!!' }, color: '#112233', active: true }
        ],
        products: [],
        modifierGroups: [],
        menus: [],
        rooms: [],
        tables: [],
        paymentMethods: [],
        profiles: []
      })
      expect(asProfile(exportProfile(t.db)).catalog.categories.map((c) => c.code)).toEqual([
        'patisserie-marocaine',
        'patisserie-marocaine-2',
        'item'
      ])
    })
  })

  describe('legal rows a profile must still be able to express', () => {
    const seedRetail = (): void => {
      seedSetup(t.db, loadTemplate('retail'))
    }
    const exported = (): Profile => asProfile(exportProfile(t.db))
    const thrownBy = (fn: () => unknown): unknown => {
      try {
        fn()
      } catch (error) {
        return error
      }
      return undefined
    }

    it('never carries live inventory: stock is 0, tracking and the alert threshold stay', () => {
      seedRetail()
      // An oversold product (the till never refuses to oversell) must not brick the export.
      t.db.prepare("UPDATE products SET stock_milli = -1000 WHERE barcode = '2000000000015'").run()
      const buf = exportProfile(t.db)
      const profile = asProfile(buf)
      expect(profile.catalog.products).toHaveLength(loadTemplate('retail').products.length)
      for (const p of profile.catalog.products) {
        expect(p).toMatchObject({ stock_tracked: true, stock_milli: 0, low_stock_milli: 6000 })
      }
      expect(profile).toEqual(JSON.parse(unzip(buf)))
    })

    it('leaves out an empty or blank Arabic or English name instead of failing', () => {
      seedRetail()
      t.db.prepare(`UPDATE products SET name_json = '{"fr":"Sucre","ar":"","en":"  "}' WHERE barcode = '2000000000015'`).run()
      t.db.prepare(`UPDATE categories SET name_json = '{"fr":"Épicerie","ar":"البقالة","en":""}' WHERE name_json LIKE '%Épicerie%'`).run()
      const profile = exported()
      expect(profile.catalog.products[0]!.name).toStrictEqual({ fr: 'Sucre' })
      expect(profile.catalog.categories[0]!.name).toStrictEqual({ fr: 'Épicerie', ar: 'البقالة' })
    })

    it('round-trips a short or alphanumeric barcode', () => {
      seedRetail()
      t.db.prepare("UPDATE products SET barcode = '123' WHERE barcode = '2000000000015'").run()
      t.db.prepare("UPDATE products SET barcode = 'AB-12c' WHERE barcode = '2000000000022'").run()
      t.db.prepare("UPDATE products SET barcode = ? WHERE barcode = '2000000000039'").run('Z'.repeat(32))
      const barcodes = exported().catalog.products.slice(0, 3).map((p) => p.barcode)
      expect(barcodes).toEqual(['123', 'AB-12c', 'Z'.repeat(32)])
    })

    it('clamps a negative table position to the grid', () => {
      seedSetup(t.db, restaurant)
      t.db.prepare("UPDATE tables SET x = -20, y = -1 WHERE label = '1'").run()
      const first = exported().tables.find((x) => x.label === '1')!
      expect([first.x, first.y]).toEqual([0, 0])
    })

    it('turns a payment method code that is not a code into one, keeping valid codes and staying unique', () => {
      seedSetup(t.db, restaurant)
      t.db.prepare("UPDATE payment_methods SET code = 'mobile_pay' WHERE code = 'card'").run()
      t.db.prepare("UPDATE payment_methods SET code = 'Mobile Pay!' WHERE code = 'cheque'").run()
      expect(exported().paymentMethods.map((m) => m.code)).toEqual(['cash', 'mobile_pay', 'mobile-pay'])

      t.db.prepare("UPDATE payment_methods SET code = 'mobile pay' WHERE code = 'mobile_pay'").run()
      expect(exported().paymentMethods.map((m) => m.code)).toEqual(['cash', 'mobile-pay', 'mobile-pay-2'])
    })

    it('reports what it cannot express as profile_export_failed, never as a raw ZodError', () => {
      seedRetail()
      t.db.prepare("UPDATE products SET price_cents = -5 WHERE barcode = '2000000000015'").run()
      const error = thrownBy(() => exportProfile(t.db))
      expect(error).toBeInstanceOf(AppErrorException)
      expect(error).toMatchObject({
        code: 'profile_export_failed',
        messageKey: 'errors.profile_export_failed',
        params: { field: 'catalog.products.0.price_cents' }
      })
    })

    it('reports an unreadable name as profile_export_failed too', () => {
      seedRetail()
      t.db.prepare("UPDATE categories SET name_json = '{not json'").run()
      expect(thrownBy(() => exportProfile(t.db))).toMatchObject({ code: 'profile_export_failed' })
      t.db.prepare(`UPDATE categories SET name_json = '{"fr":"  "}'`).run()
      expect(thrownBy(() => exportProfile(t.db))).toMatchObject({ code: 'profile_export_failed' })
    })
  })

  describe('round trip', () => {
    it('reading an export gives back exactly what was written', () => {
      installRestaurant(t.db, restaurant)
      const buf = exportProfile(t.db, { clock: fixedClock(), appVersion: '1.0.0' })
      expect(asProfile(buf)).toEqual(JSON.parse(unzip(buf)))
    })

    it('importing the profile on a second machine and exporting again gives the same profile', () => {
      installRestaurant(t.db, restaurant)
      const first = asProfile(exportProfile(t.db, { clock: fixedClock('2026-10-23T08:00:00.000Z'), appVersion: '1.0.0' }))

      const other = tempDb()
      try {
        seedSetup(other.db, {
          ...first.catalog,
          rooms: first.rooms,
          tables: first.tables,
          paymentMethods: first.paymentMethods,
          profiles: first.profiles,
          printers: first.printers,
          routing: first.routing
        })
        const uow = createUnitOfWork(other.db, fixedClock(), createEventBus())
        const repo = createSettingsRepo(other.db)
        uow.run((tx) => {
          // Test-only replay of a profile's settings: the real import is a setup use case.
          for (const [key, value] of Object.entries(first.settings)) repo.set(tx, key as SettingKey, value as never)
          repo.set(tx, 'modules', first.modules)
        })

        const second = asProfile(
          exportProfile(other.db, { clock: fixedClock('2026-12-01T09:00:00.000Z'), appVersion: '1.0.0' })
        )
        expect({ ...second, createdAt: first.createdAt }).toEqual(first)
        expect(second.createdAt).not.toBe(first.createdAt)
      } finally {
        other.cleanup()
      }
    })
  })

  describe('readProfile', () => {
    const valid = (): Profile => {
      installRestaurant(t.db, restaurant)
      return asProfile(exportProfile(t.db))
    }

    it('returns ok for an export', () => {
      expect(readProfile(exportProfile(t.db)).ok).toBe(true)
    })

    it('rejects data that is not a gzip', () => {
      expect(errorOf(Buffer.from('plain text'))).toMatchObject({ code: 'invalid_profile', messageKey: 'errors.invalid_profile' })
      expect(errorOf(Buffer.alloc(0)).code).toBe('invalid_profile')
    })

    it('rejects a gzip that is not JSON, or not an atlasprofile', () => {
      expect(errorOf(gz('{not json')).code).toBe('invalid_profile')
      expect(errorOf(gz({ hello: 'world' })).code).toBe('invalid_profile')
      expect(errorOf(gz({ format: 'something-else', schemaVersion: 1 })).code).toBe('invalid_profile')
      expect(errorOf(gz([1, 2, 3])).code).toBe('invalid_profile')
    })

    it('rejects a schemaVersion greater than 1 with its own error, before looking at the rest', () => {
      const error = errorOf(gz({ format: 'atlasprofile', schemaVersion: 2, somethingNew: { shape: 'unknown' } }))
      expect(error).toMatchObject({
        code: 'profile_newer_version',
        messageKey: 'errors.profile_newer_version',
        params: { found: 2, supported: 1 }
      })
    })

    it.each([0, -1, 1.5, '1', null])('rejects the schemaVersion %j', (schemaVersion) => {
      expect(errorOf(gz({ ...valid(), schemaVersion })).code).toBe('invalid_profile')
    })

    it('rejects a forged technician code hash', () => {
      const profile = valid()
      const forged = { ...profile, settings: { ...profile.settings, 'tech.codeHash': 'scrypt$attacker' } }
      const error = errorOf(gz(forged))
      expect(error.code).toBe('invalid_profile')
      expect(JSON.stringify(error.params)).toContain('tech.codeHash')
    })

    it('rejects a missing section, an invalid value and a dangling reference, naming the field', () => {
      const profile = valid()
      const { printers: _printers, ...withoutPrinters } = profile
      expect(errorOf(gz(withoutPrinters)).params).toMatchObject({ field: 'printers' })

      const badIce = { ...profile, settings: { ...profile.settings, 'business.legal': { ...legal, ice: '123' } } }
      expect(errorOf(gz(badIce)).params).toMatchObject({ field: 'settings.business.legal.ice' })

      const dangling = structuredClone(profile)
      dangling.catalog.products[0]!.category = 'nowhere'
      expect(errorOf(gz(dangling)).code).toBe('invalid_profile')

      const badRoute = structuredClone(profile)
      badRoute.routing['plats'] = ['no-such-printer']
      expect(errorOf(gz(badRoute)).code).toBe('invalid_profile')
    })

    it('rejects an unknown permission', () => {
      const profile = structuredClone(valid())
      // @ts-expect-error not a permission
      profile.profiles[0]!.permissions.push('root.everything')
      expect(errorOf(gz(profile)).code).toBe('invalid_profile')
    })

    it('accepts a short or alphanumeric barcode but not spaces or more than 32 characters', () => {
      const base = valid()
      const withBarcode = (barcode: string): Profile => {
        const profile = structuredClone(base)
        profile.catalog.products[0]!.barcode = barcode
        return profile
      }
      expect(readProfile(gz(withBarcode('AB-12c'))).ok).toBe(true)
      expect(readProfile(gz(withBarcode('1'))).ok).toBe(true)
      expect(errorOf(gz(withBarcode('has space'))).code).toBe('invalid_profile')
      expect(errorOf(gz(withBarcode('Z'.repeat(33)))).code).toBe('invalid_profile')
      expect(errorOf(gz(withBarcode(''))).code).toBe('invalid_profile')
    })

    it('rejects a device path injected into a printer that is not on the network', () => {
      const base = valid()
      const profile = structuredClone(base)
      const serial = profile.printers.findIndex((p) => p.kind === 'serial')
      expect(serial).toBeGreaterThanOrEqual(0)
      profile.printers[serial]!.address = 'COM3'
      expect(errorOf(gz(profile))).toMatchObject({
        code: 'invalid_profile',
        params: { field: `printers.${serial}.address` }
      })
      // A network printer may carry its address.
      expect(base.printers.some((p) => p.kind === 'network' && p.address)).toBe(true)
      expect(readProfile(gz(base)).ok).toBe(true)
    })

    it('refuses a gzip bomb', () => {
      expect(errorOf(gzipSync(Buffer.alloc(64 * 1024 * 1024))).code).toBe('invalid_profile')
    })
  })
})
