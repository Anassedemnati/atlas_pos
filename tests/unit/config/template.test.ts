import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from '@shared/permissions'
import { defaultOf } from '../../../src/main/domain/config/settings-registry'
import {
  LocalizedNameSchema,
  NAME_MAX_LENGTH,
  TEMPLATE_IDS,
  TemplateSchema,
  loadTemplate,
  type Template
} from '../../../src/main/domain/config/template'

const ARABIC = /[؀-ۿ]/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DRINK_CATEGORIES = new Set([
  'boissons-chaudes',
  'boissons-fraiches',
  'jus',
  'cafes',
  'thes',
  'jus-boissons'
])

const all = (): Template[] => TEMPLATE_IDS.map((id) => loadTemplate(id))
const dupes = (values: string[]): string[] => values.filter((v, i) => values.indexOf(v) !== i)

describe('business templates', () => {
  it('ships the four business types', () => {
    expect([...TEMPLATE_IDS]).toEqual(['restaurant', 'cafe', 'bakery', 'retail'])
  })

  it.each(TEMPLATE_IDS)('%s validates and carries its own id', (id) => {
    const t = loadTemplate(id)
    expect(t.id).toBe(id)
    expect(t.version).toBeGreaterThanOrEqual(1)
    expect(TemplateSchema.safeParse(t).success).toBe(true)
  })

  it('returns a fresh object on every load', () => {
    const a = loadTemplate('cafe')
    a.products.length = 0
    expect(loadTemplate('cafe').products.length).toBeGreaterThan(0)
  })

  it('refuses an unknown template id', () => {
    // @ts-expect-error not a template id
    expect(() => loadTemplate('garage')).toThrow(/garage/)
  })

  describe('module defaults (spec section 5.3)', () => {
    it('restaurant: floor plan, kitchen, menus and customers', () => {
      expect(loadTemplate('restaurant').modules).toEqual({
        tables: true,
        kitchen: true,
        menus: true,
        customers: true,
        stock: false,
        barcode: false,
        scale: false
      })
    })
    it('cafe: kitchen and menus', () => {
      expect(loadTemplate('cafe').modules).toEqual({
        tables: false,
        kitchen: true,
        menus: true,
        customers: false,
        stock: false,
        barcode: false,
        scale: false
      })
    })
    it('bakery: nothing optional (scale is OFF by default)', () => {
      expect(Object.values(loadTemplate('bakery').modules).every((on) => !on)).toBe(true)
    })
    it('retail: stock and barcode', () => {
      expect(loadTemplate('retail').modules).toEqual({
        tables: false,
        kitchen: false,
        menus: false,
        customers: false,
        stock: true,
        barcode: true,
        scale: false
      })
    })
  })

  describe.each(TEMPLATE_IDS)('%s content', (id) => {
    const t = loadTemplate(id)

    it('names every product in French and (almost) always in Arabic', () => {
      expect(t.products.every((p) => p.name.fr.trim() !== '')).toBe(true)
      const withArabic = t.products.filter((p) => p.name.ar && ARABIC.test(p.name.ar))
      expect(withArabic.length / t.products.length).toBeGreaterThanOrEqual(0.9)
      for (const c of t.categories) expect(c.name.ar, c.code).toMatch(ARABIC)
    })

    it('uses valid, unique, kebab-case codes', () => {
      for (const list of [t.categories, t.products, t.modifierGroups, t.rooms, t.paymentMethods, t.profiles]) {
        expect(list.every((x) => KEBAB.test(x.code))).toBe(true)
        expect(dupes(list.map((x) => x.code))).toEqual([])
      }
    })

    it('lists products grouped by category, in the order of the categories', () => {
      const position = t.products.map((p) => t.categories.findIndex((c) => c.code === p.category))
      expect(position).toEqual([...position].sort((a, b) => a - b))
    })

    it('prices in centimes and only uses the default VAT rates', () => {
      const rates = defaultOf('vat.rates')
      for (const p of t.products) {
        expect(Number.isInteger(p.price_cents) && p.price_cents > 0, p.code).toBe(true)
        expect(rates, p.code).toContain(p.vat_bp)
      }
      for (const c of t.categories) expect(c.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    })

    it('marks about 12 best sellers for illustration', () => {
      const images = t.products.filter((p) => p.image)
      expect(images.length).toBeGreaterThanOrEqual(10)
      expect(images.length).toBeLessThanOrEqual(14)
    })

    it('has every reference resolved', () => {
      const categories = new Set(t.categories.map((c) => c.code))
      const groups = new Set(t.modifierGroups.map((g) => g.code))
      const products = new Set(t.products.map((p) => p.code))
      for (const p of t.products) {
        expect(categories.has(p.category), p.code).toBe(true)
        for (const g of p.modifier_groups) expect(groups.has(g), `${p.code}:${g}`).toBe(true)
      }
      for (const m of t.menus) {
        expect(products.has(m.product)).toBe(true)
        for (const course of m.courses) for (const item of course.items) expect(products.has(item.product)).toBe(true)
      }
      for (const code of Object.keys(t.printersRouting)) expect(categories.has(code), code).toBe(true)
    })

    it("lists a product's modifier groups in the order of the groups", () => {
      const order = t.modifierGroups.map((g) => g.code)
      for (const p of t.products) {
        const positions = p.modifier_groups.map((g) => order.indexOf(g))
        expect(positions, p.code).toEqual([...positions].sort((a, b) => a - b))
      }
    })

    it('has a cash payment method that opens the drawer, a card, and an inactive cheque', () => {
      const byCode = Object.fromEntries(t.paymentMethods.map((m) => [m.code, m]))
      expect(byCode['cash']).toMatchObject({ opens_drawer: true, active: true })
      expect(byCode['card']).toMatchObject({ opens_drawer: false, active: true })
      expect(byCode['cheque']).toMatchObject({ active: false })
      for (const m of t.paymentMethods) expect(m.name.ar).toMatch(ARABIC)
    })

    it('has the three default permission profiles', () => {
      const byCode = Object.fromEntries(t.profiles.map((p) => [p.code, p]))
      expect(Object.keys(byCode).sort()).toEqual(['caissier', 'gerant', 'serveur'])
      expect([...(byCode['gerant']?.permissions ?? [])].sort()).toEqual([...PERMISSIONS].sort())
      expect(byCode['gerant']?.max_discount_bp).toBe(10000)
      expect(byCode['caissier']).toMatchObject({
        permissions: ['order.discount', 'report.x', 'ticket.reprint'],
        max_discount_bp: 1000
      })
      expect(byCode['serveur']).toMatchObject({ permissions: ['order.discount'], max_discount_bp: 0 })
      expect(byCode['gerant']?.name).toEqual({ fr: 'Gérant', ar: 'مدير', en: 'Manager' })
    })

    it('uses only template settings that exist', () => {
      expect(TemplateSchema.safeParse({ ...t, settings: { ...t.settings, 'no.such.key': 1 } }).success).toBe(false)
    })

    it('routes drinks to the bar and food to the kitchen', () => {
      for (const [category, role] of Object.entries(t.printersRouting)) {
        expect(role, category).toBe(DRINK_CATEGORIES.has(category) ? 'bar' : 'kitchen')
      }
      const kitchenModule = t.modules.kitchen
      expect(Object.keys(t.printersRouting).length > 0, 'routing present iff kitchen module').toBe(kitchenModule)
      if (kitchenModule) expect(Object.keys(t.printersRouting).sort()).toEqual(t.categories.map((c) => c.code).sort())
    })
  })

  describe('restaurant', () => {
    const t = loadTemplate('restaurant')

    it('has the expected categories, at least 30 products and a quality Moroccan offer', () => {
      expect(t.categories.length).toBeGreaterThanOrEqual(6)
      const names = t.categories.map((c) => c.name.fr)
      for (const n of ['Entrées', 'Plats', 'Grillades', 'Desserts', 'Boissons chaudes', 'Jus']) expect(names).toContain(n)
      expect(t.products.length).toBeGreaterThanOrEqual(30)
      const byCode = Object.fromEntries(t.products.map((p) => [p.code, p]))
      expect(byCode['harira']?.name.ar).toBe('حريرة')
      expect(byCode['couscous-royal']?.name.ar).toBe('كسكس ملكي')
      expect(byCode['tajine-poulet-citron']).toMatchObject({ price_cents: 7000, vat_bp: 1000 })
      expect(byCode['the-menthe']).toMatchObject({ price_cents: 1200, vat_bp: 1000 })
      expect(byCode['cafe-noir']).toMatchObject({ price_cents: 1000, vat_bp: 1000 })
      expect(t.products.every((p) => p.vat_bp === 1000)).toBe(true)
    })

    it('has the Cuisson and Sans... modifier groups, used by real products', () => {
      const names = t.modifierGroups.map((g) => g.name.fr)
      expect(names).toContain('Cuisson')
      expect(names).toContain('Sans…')
      for (const g of t.modifierGroups) {
        expect(t.products.some((p) => p.modifier_groups.includes(g.code)), g.code).toBe(true)
      }
    })

    it('has the Menu du jour: a starter, a main and a drink', () => {
      expect(t.menus).toHaveLength(1)
      const menu = t.menus[0]!
      const product = t.products.find((p) => p.code === menu.product)!
      expect(product.name.fr).toBe('Menu du jour')
      const categoryOf = (code: string): string => t.products.find((p) => p.code === code)!.category
      const courses = menu.courses.map((c) => ({ name: c.name.fr, categories: new Set(c.items.map((i) => categoryOf(i.product))) }))
      expect(courses.map((c) => c.name)).toEqual(['Entrée', 'Plat', 'Boisson'])
      expect(courses[0]!.categories).toEqual(new Set(['entrees']))
      expect([...courses[1]!.categories].every((c) => c === 'plats' || c === 'grillades')).toBe(true)
      expect([...courses[2]!.categories].every((c) => c.startsWith('boissons') || c === 'jus')).toBe(true)
    })

    it('lays out Salle (14) and Terrasse (6) on a 1000x600 grid without overlaps', () => {
      expect(t.rooms.map((r) => r.name.fr)).toEqual(['Salle', 'Terrasse'])
      const count = (room: string): number => t.tables.filter((x) => x.room === room).length
      expect(count('salle')).toBe(14)
      expect(count('terrasse')).toBe(6)
      for (const room of t.rooms) {
        const tables = t.tables.filter((x) => x.room === room.code)
        expect(dupes(tables.map((x) => x.label)), room.code).toEqual([])
        for (const x of tables) {
          expect(x.x >= 0 && x.y >= 0 && x.x + x.w <= 1000 && x.y + x.h <= 600, `${room.code} ${x.label}`).toBe(true)
        }
        for (const [i, a] of tables.entries()) {
          for (const b of tables.slice(i + 1)) {
            const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
            expect(overlap, `${room.code}: ${a.label} / ${b.label}`).toBe(false)
          }
        }
      }
      expect(dupes(t.tables.map((x) => x.label))).toEqual([])
    })

    it('numbers courses so that starters are sent before mains', () => {
      const course = (code: string): number => t.products.find((p) => p.code === code)!.course
      expect(course('harira')).toBe(1)
      expect(course('tajine-poulet-citron')).toBe(2)
      expect(course('fruits-de-saison')).toBe(3)
      expect(course('the-menthe')).toBe(0)
    })
  })

  describe('cafe', () => {
    const t = loadTemplate('cafe')
    it('has coffees, teas, juices, viennoiseries, sandwiches and at least 25 products', () => {
      expect(t.products.length).toBeGreaterThanOrEqual(25)
      const names = t.categories.map((c) => c.name.fr).join(' | ')
      for (const word of ['Café', 'Thé', 'Jus', 'Viennoiseries', 'Sandwich']) expect(names).toContain(word)
      expect(t.products.every((p) => p.vat_bp === 1000)).toBe(true)
    })
    it('has a breakfast formula as a set menu', () => {
      expect(t.menus).toHaveLength(1)
      expect(t.products.find((p) => p.code === t.menus[0]!.product)?.name.fr).toBe('Formule petit-déjeuner')
    })
    it('keeps the Moroccan pancakes and flatbreads out of the viennoiseries', () => {
      const category = (code: string): string => t.products.find((p) => p.code === code)!.category
      for (const code of ['msemen', 'baghrir', 'harcha']) expect(category(code), code).toBe('crepes-galettes')
      expect(t.products.filter((p) => p.category === 'viennoiseries').map((p) => p.code)).toEqual([
        'croissant',
        'pain-chocolat',
        'pain-raisins',
        'brioche'
      ])
      expect(t.categories.find((c) => c.code === 'crepes-galettes')?.name).toEqual({
        fr: 'Crêpes et galettes',
        ar: 'الفطائر المغربية',
        en: 'Moroccan pancakes and flatbreads'
      })
    })
    it('prices the examples from the guidance', () => {
      const byCode = Object.fromEntries(t.products.map((p) => [p.code, p]))
      expect(byCode['cafe-noir']).toMatchObject({ price_cents: 1000 })
      expect(byCode['the-menthe']).toMatchObject({ price_cents: 1200 })
      expect(byCode['croissant']).toMatchObject({ price_cents: 400 })
      expect(byCode['msemen']).toMatchObject({ price_cents: 300 })
    })
  })

  describe('bakery', () => {
    const t = loadTemplate('bakery')
    it('sells at least 3 products by weight, priced per kg', () => {
      const weighed = t.products.filter((p) => p.sold_by_weight)
      expect(weighed.length).toBeGreaterThanOrEqual(3)
      expect(weighed.find((p) => p.code === 'chebakia')).toMatchObject({ price_cents: 12000 })
    })
    it('has no weight item outside the pastry shelves', () => {
      for (const p of t.products.filter((x) => x.sold_by_weight)) expect(p.category).toBe('patisserie-marocaine')
    })
    it('charges bread 0 % and pastries 20 %', () => {
      const bread = t.products.filter((p) => p.category === 'pains')
      expect(bread.length).toBeGreaterThan(0)
      expect(bread.every((p) => p.vat_bp === 0)).toBe(true)
      const byCode = Object.fromEntries(t.products.map((p) => [p.code, p]))
      expect(byCode['baguette']).toMatchObject({ price_cents: 300, vat_bp: 0 })
      expect(byCode['croissant']).toMatchObject({ price_cents: 400, vat_bp: 2000 })
      expect(byCode['msemen']).toMatchObject({ price_cents: 300 })
    })
    it('has the four families', () => {
      const names = t.categories.map((c) => c.name.fr)
      for (const n of ['Pains', 'Viennoiseries', 'Pâtisseries', 'Pâtisserie marocaine']) expect(names).toContain(n)
    })
  })

  describe('retail', () => {
    const t = loadTemplate('retail')
    it('has demo EAN-13 barcodes in the in-store 200 range, valid and unique', () => {
      expect(t.products.length).toBeGreaterThanOrEqual(25)
      const ean13Valid = (code: string): boolean => {
        const digits = [...code].map(Number)
        const sum = digits.slice(0, 12).reduce((s, d, i) => s + d * (i % 2 === 0 ? 1 : 3), 0)
        return (10 - (sum % 10)) % 10 === digits[12]
      }
      for (const p of t.products) {
        expect(p.barcode, p.code).toMatch(/^200\d{10}$/)
        expect(ean13Valid(p.barcode!), `${p.code} ${p.barcode}`).toBe(true)
      }
      expect(dupes(t.products.map((p) => p.barcode!))).toEqual([])
    })
    it('tracks stock for every product, with a low-stock threshold below the stock', () => {
      for (const p of t.products) {
        expect(p.stock_tracked, p.code).toBe(true)
        expect(p.stock_milli, p.code).toBeGreaterThan(p.low_stock_milli)
        expect(p.low_stock_milli, p.code).toBeGreaterThan(0)
      }
    })
    it('mixes the 20 %, 7 % and 0 % rates', () => {
      expect(new Set(t.products.map((p) => p.vat_bp))).toEqual(new Set([2000, 700, 0]))
    })
  })

  describe('integrity rules of the schema', () => {
    const base = (): Template => loadTemplate('retail')

    it('rejects a product in an unknown category', () => {
      const t = base()
      t.products[0]!.category = 'nowhere'
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects duplicate product codes', () => {
      const t = base()
      t.products[1]!.code = t.products[0]!.code
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects duplicate barcodes', () => {
      const t = base()
      t.products[1]!.barcode = t.products[0]!.barcode
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects a table in an unknown room', () => {
      const t = loadTemplate('restaurant')
      t.tables[0]!.room = 'nowhere'
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects a menu whose product does not exist', () => {
      const t = loadTemplate('restaurant')
      t.menus[0]!.product = 'nowhere'
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects a route for an unknown category', () => {
      const t = loadTemplate('restaurant')
      t.printersRouting['nowhere'] = 'bar'
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects a name without French', () => {
      const t = base()
      // @ts-expect-error fr is required
      t.products[0]!.name = { ar: 'سكر' }
      expect(TemplateSchema.safeParse(t).success).toBe(false)
    })
    it('rejects a negative price and a misspelled field', () => {
      const t = base()
      t.products[0]!.price_cents = -1
      expect(TemplateSchema.safeParse(t).success).toBe(false)
      const misspelled = { ...base(), products: base().products.map((p) => ({ ...p, price_cent: 1 })) }
      expect(TemplateSchema.safeParse(misspelled).success).toBe(false)
    })
  })
})

describe('names', () => {
  it('may be 200 characters long in every language, not 201', () => {
    expect(NAME_MAX_LENGTH).toBe(200)
    for (const lang of ['fr', 'ar', 'en'] as const) {
      expect(LocalizedNameSchema.safeParse({ fr: 'a', [lang]: 'é'.repeat(200) }).success).toBe(true)
      expect(LocalizedNameSchema.safeParse({ fr: 'a', [lang]: 'é'.repeat(201) }).success).toBe(false)
    }
  })

  it('refuses a template whose product, category or modifier name is over the limit', () => {
    const long = 'é'.repeat(201)
    const product = loadTemplate('retail')
    product.products[0]!.name.fr = long
    expect(TemplateSchema.safeParse(product).success).toBe(false)
    const category = loadTemplate('retail')
    category.categories[0]!.name.ar = long
    expect(TemplateSchema.safeParse(category).success).toBe(false)
  })

  it('every shipped template stays within the limit', () => {
    for (const t of all()) expect(TemplateSchema.safeParse(t).success).toBe(true)
  })
})
