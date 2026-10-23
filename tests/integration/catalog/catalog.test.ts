import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogDto, ProductDto } from '../../../src/shared/dto'
import type { Result } from '../../../src/shared/result'
import { readProfile, exportProfile } from '../../../src/main/infrastructure/profile/profile-io'
import type { MenuInput } from '../../../src/main/application/usecases/catalog'
import { catalogHarness, insertOrderLine, type CatalogHarness } from '../../helpers/catalog'

const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)

/** The value of a successful result; fails the test with the error otherwise. */
function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

describe('catalog use cases', () => {
  let h: CatalogHarness
  beforeEach(() => {
    h = catalogHarness()
  })
  afterEach(() => h.cleanup())

  const category = (name = 'Boissons') => ok(h.service.saveCategory(h.manager, { name: { fr: name } })).id
  const product = (categoryId: string, over: Record<string, unknown> = {}): string =>
    ok(
      h.service.saveProduct(h.manager, {
        categoryId,
        name: { fr: 'Eau 1,5 L' },
        priceCents: 750,
        vatBp: 2000,
        ...over
      })
    ).id
  const catalog = (): CatalogDto => h.service.listCatalog()
  const find = (id: string): ProductDto => {
    const p = catalog().products.find((x) => x.id === id)
    if (!p) throw new Error(`no product ${id}`)
    return p
  }

  describe('permissions', () => {
    it('saveProduct without catalog.manage is forbidden and writes nothing', () => {
      const categoryId = category()
      const r = h.service.saveProduct(h.cashier, { categoryId, name: { fr: 'Thé' }, priceCents: 500, vatBp: 2000 })
      expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'catalog.manage' } } })
      expect(h.count('products')).toBe(0)
    })

    it.each([
      ['saveCategory', () => h.service.saveCategory(h.cashier, { name: { fr: 'X' } })],
      ['deleteCategory', () => h.service.deleteCategory(h.cashier, 'x')],
      ['deleteProduct', () => h.service.deleteProduct(h.cashier, 'x')],
      [
        'saveModifierGroup',
        () => h.service.saveModifierGroup(h.cashier, { name: { fr: 'X' }, modifiers: [{ name: { fr: 'a' } }] })
      ],
      ['saveMenu', () => h.service.saveMenu(h.cashier, { productId: 'x', courses: [] })],
      ['reorder', () => h.service.reorder(h.cashier, 'category', [])],
      ['adjustStock', () => h.service.adjustStock(h.cashier, 'x', 1000, 'inventaire')],
      ['quickCreateProduct', () => h.service.quickCreateProduct(h.cashier, '123', 'X', 100, 'x')],
      ['applyCatalogImport', () => h.service.applyCatalogImport(h.cashier, [], 'merge')]
    ])('%s needs catalog.manage', (_name, run) => {
      expect(code(run())).toBe('forbidden')
      expect(h.eventRows()).toEqual([])
      expect(h.published).toEqual([])
    })
  })

  describe('saveCategory / deleteCategory', () => {
    it('creates a category with a default colour, appends it, logs it and announces catalog.changed', () => {
      const a = category('Boissons')
      const b = ok(h.service.saveCategory(h.manager, { name: { fr: 'Épicerie', ar: ' ', en: 'Grocery' }, color: '#14213D' })).id
      expect(catalog().categories).toEqual([
        { id: a, name: { fr: 'Boissons' }, color: '#0FA3A3', sort: 0, active: true, imagePath: null },
        { id: b, name: { fr: 'Épicerie', en: 'Grocery' }, color: '#14213D', sort: 1, active: true, imagePath: null }
      ])
      const logged = h.eventRows().filter((e) => e.type === 'category.saved')
      expect(logged).toHaveLength(2)
      expect(logged[0]).toMatchObject({ entity: 'category', entity_id: a, user_id: 'u-manager' })
      expect(h.published).toEqual([{ type: 'catalog.changed' }, { type: 'catalog.changed' }])
    })

    it('edits a category, keeping what the input leaves out', () => {
      const id = category('Boissons')
      ok(h.service.saveCategory(h.manager, { id, name: { fr: 'Boissons fraîches' }, active: false }))
      expect(catalog().categories[0]).toMatchObject({ name: { fr: 'Boissons fraîches' }, color: '#0FA3A3', active: false })
    })

    it.each([
      ['no French name', { name: { fr: ' ' } }, 'name.fr'],
      ['a colour that is not #RRGGBB', { name: { fr: 'X' }, color: 'red' }, 'color'],
      ['an unknown id', { id: 'nope', name: { fr: 'X' } }, 'id'],
      ['an image path leaving the media folder', { name: { fr: 'X' }, imagePath: '../secret.png' }, 'imagePath']
    ])('refuses %s as invalid_input', (_why, input, field) => {
      const r = h.service.saveCategory(h.manager, input)
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
      expect(h.count('categories')).toBe(0)
      expect(h.published).toEqual([])
    })

    it('deletes an empty category', () => {
      const id = category()
      expect(ok(h.service.deleteCategory(h.manager, id))).toEqual({ id })
      expect(h.count('categories')).toBe(0)
      expect(h.eventRows().map((e) => e.type)).toEqual(['category.saved', 'category.deleted'])
    })

    it('takes the printer routing of a deleted category with it', () => {
      const id = category()
      h.t.db.prepare("INSERT INTO printers (id, name, kind, role) VALUES ('pr1', 'Cuisine', 'network', 'kitchen')").run()
      h.t.db.prepare("INSERT INTO category_printers (category_id, printer_id) VALUES (?, 'pr1')").run(id)
      ok(h.service.deleteCategory(h.manager, id))
      expect(h.count('category_printers')).toBe(0)
      expect(h.count('printers')).toBe(1)
    })

    it('refuses to delete a category that still has products, inactive ones included', () => {
      const id = category()
      const p = product(id)
      expect(code(h.service.deleteCategory(h.manager, id))).toBe('category_not_empty')
      ok(h.service.saveProduct(h.manager, { id: p, categoryId: id, name: { fr: 'x' }, priceCents: 1, vatBp: 0, active: false }))
      expect(code(h.service.deleteCategory(h.manager, id))).toBe('category_not_empty')
      expect(h.count('categories')).toBe(1)
    })
  })

  describe('saveProduct', () => {
    it('creates a product with the defaults, appended after the others', () => {
      const c = category()
      const a = product(c)
      const b = product(c, { name: { fr: 'Thé', ar: 'شاي' }, barcode: ' 611 ', color: '#D64545' })
      expect(find(a)).toEqual({
        id: a,
        categoryId: c,
        name: { fr: 'Eau 1,5 L' },
        priceCents: 750,
        vatBp: 2000,
        barcode: null,
        soldByWeight: false,
        color: null,
        imagePath: null,
        keySize: 1,
        sort: 0,
        active: true,
        stockTracked: false,
        stockMilli: 0,
        lowStockMilli: 0,
        course: 0,
        modifierGroupIds: []
      })
      expect(find(b)).toMatchObject({ sort: 1, name: { fr: 'Thé', ar: 'شاي' }, color: '#D64545' })
      expect(find(b).barcode).toBe('611')
    })

    it('stores no barcode for a blank one, so two products can both have none', () => {
      const c = category()
      const a = product(c, { barcode: '' })
      const b = product(c, { barcode: '   ' })
      expect([find(a).barcode, find(b).barcode]).toEqual([null, null])
    })

    it('edits a product: absent fields stay, null clears barcode and colour', () => {
      const c = category()
      const id = product(c, { barcode: '611', color: '#D64545', soldByWeight: true, keySize: 2, course: 1 })
      ok(h.service.saveProduct(h.manager, { id, categoryId: c, name: { fr: 'Eau' }, priceCents: 800, vatBp: 1000 }))
      expect(find(id)).toMatchObject({
        name: { fr: 'Eau' },
        priceCents: 800,
        vatBp: 1000,
        barcode: '611',
        color: '#D64545',
        soldByWeight: true,
        keySize: 2,
        course: 1
      })
      ok(h.service.saveProduct(h.manager, { id, categoryId: c, name: { fr: 'Eau' }, priceCents: 800, vatBp: 1000, barcode: null, color: null }))
      expect(find(id)).toMatchObject({ barcode: null, color: null })
    })

    it('refuses a barcode another product has, on create and on edit', () => {
      const c = category()
      const a = product(c, { barcode: '611' })
      const b = product(c, { name: { fr: 'Thé' }, barcode: '612' })
      const dup = h.service.saveProduct(h.manager, { categoryId: c, name: { fr: 'Z' }, priceCents: 1, vatBp: 0, barcode: '611' })
      expect(dup).toMatchObject({ ok: false, error: { code: 'barcode_taken', params: { barcode: '611' } } })
      expect(code(h.service.saveProduct(h.manager, { id: b, categoryId: c, name: { fr: 'Thé' }, priceCents: 1, vatBp: 0, barcode: '611' }))).toBe('barcode_taken')
      // its own barcode is fine
      ok(h.service.saveProduct(h.manager, { id: a, categoryId: c, name: { fr: 'Eau' }, priceCents: 1, vatBp: 0, barcode: '611' }))
      expect(h.count('products')).toBe(2)
    })

    it.each([
      ['an unknown category', { categoryId: 'nope' }, 'categoryId'],
      ['a negative price', { priceCents: -1 }, 'priceCents'],
      ['a fractional price', { priceCents: 7.5 }, 'priceCents'],
      ['a VAT rate over 100 %', { vatBp: 10001 }, 'vatBp'],
      ['a barcode with a space inside', { barcode: 'ab cd' }, 'barcode'],
      ['a barcode over 32 characters', { barcode: '1'.repeat(33) }, 'barcode'],
      ['a colour that is not #RRGGBB', { color: '#12345' }, 'color'],
      ['a key size of 0', { keySize: 0 }, 'keySize'],
      ['a negative course', { course: -1 }, 'course'],
      ['a negative stock', { stockMilli: -1 }, 'stockMilli'],
      ['a negative low-stock threshold', { lowStockMilli: -1 }, 'lowStockMilli'],
      ['an unknown modifier group', { modifierGroupIds: ['nope'] }, 'modifierGroupIds'],
      ['an unknown id', { id: 'nope' }, 'id'],
      ['an unknown field', { price: 5 }, 'price']
    ])('refuses %s as invalid_input', (_why, over, field) => {
      const c = category()
      const r = h.service.saveProduct(h.manager, {
        categoryId: c,
        name: { fr: 'X' },
        priceCents: 100,
        vatBp: 2000,
        ...over
      })
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
      expect(h.count('products')).toBe(0)
    })

    it('links modifier groups, in the order of the groups, and relinks on edit', () => {
      const c = category()
      const g1 = ok(h.service.saveModifierGroup(h.manager, { name: { fr: 'Cuisson' }, modifiers: [{ name: { fr: 'Saignant' } }] })).id
      const g2 = ok(h.service.saveModifierGroup(h.manager, { name: { fr: 'Sauce' }, modifiers: [{ name: { fr: 'Poivre' } }] })).id
      const id = product(c, { modifierGroupIds: [g2, g1] })
      expect(find(id).modifierGroupIds).toEqual([g1, g2])
      ok(h.service.saveProduct(h.manager, { id, categoryId: c, name: { fr: 'Steak' }, priceCents: 1, vatBp: 0, modifierGroupIds: [g2] }))
      expect(find(id).modifierGroupIds).toEqual([g2])
    })

    it('logs the creation with the stock change, and announces catalog.changed once per call', () => {
      const c = category()
      h.published.length = 0
      const id = product(c, { stockTracked: true, stockMilli: 5000 })
      ok(h.service.saveProduct(h.manager, { id, categoryId: c, name: { fr: 'Eau' }, priceCents: 750, vatBp: 2000, stockMilli: 3000 }))
      const logged = h.eventRows().filter((e) => e.type === 'product.saved')
      expect(logged.map((e) => JSON.parse(e.data_json!))).toEqual([
        { created: true, stockMilli: 5000 },
        { created: false, stockMilli: 3000, previousStockMilli: 5000 }
      ])
      expect(h.published).toHaveLength(2)
    })
  })

  describe('deleteProduct', () => {
    it('removes a product that was never sold', () => {
      const c = category()
      const id = product(c)
      expect(ok(h.service.deleteProduct(h.manager, id))).toEqual({ outcome: 'deleted' })
      expect(h.count('products')).toBe(0)
      expect(h.eventRows().at(-1)).toMatchObject({ type: 'product.deleted', entity_id: id })
    })

    it('makes a product used in an order inactive instead of removing it', () => {
      const c = category()
      const id = product(c, { barcode: '611' })
      insertOrderLine(h.t.db, id)
      expect(ok(h.service.deleteProduct(h.manager, id))).toEqual({ outcome: 'deactivated' })
      expect(h.count('products')).toBe(1)
      expect(find(id)).toMatchObject({ active: false, barcode: '611' })
      const logged = h.eventRows().at(-1)!
      expect(logged).toMatchObject({ type: 'product.deleted', entity_id: id })
      expect(JSON.parse(logged.data_json!)).toEqual({ outcome: 'deactivated', name: 'Eau 1,5 L' })
      expect(h.published.at(-1)).toEqual({ type: 'catalog.changed' })
    })

    it('removes the links to modifier groups of a deleted product', () => {
      const c = category()
      const g = ok(h.service.saveModifierGroup(h.manager, { name: { fr: 'Sauce' }, modifiers: [{ name: { fr: 'Poivre' } }] })).id
      const id = product(c, { modifierGroupIds: [g] })
      ok(h.service.deleteProduct(h.manager, id))
      expect(h.count('product_modifier_groups')).toBe(0)
      expect(h.count('modifier_groups')).toBe(1)
    })

    it('deletes the menu of a deleted menu product, and only deactivates a product offered in a menu', () => {
      const c = category()
      const menuProduct = product(c, { name: { fr: 'Menu midi' } })
      const dish = product(c, { name: { fr: 'Tajine' } })
      ok(h.service.saveMenu(h.manager, { productId: menuProduct, courses: [{ name: { fr: 'Plat' }, items: [{ productId: dish }] }] }))
      expect(ok(h.service.deleteProduct(h.manager, dish))).toEqual({ outcome: 'deactivated' })
      expect(h.count('menu_course_items')).toBe(1)
      expect(ok(h.service.deleteProduct(h.manager, menuProduct))).toEqual({ outcome: 'deleted' })
      expect([h.count('menus'), h.count('menu_courses'), h.count('menu_course_items')]).toEqual([0, 0, 0])
    })

    it('refuses an unknown product', () => {
      expect(h.service.deleteProduct(h.manager, 'nope')).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'id' } } })
    })
  })

  describe('saveModifierGroup', () => {
    const group = (over: Record<string, unknown> = {}) => ({
      name: { fr: 'Sauce' },
      minSelect: 0,
      maxSelect: 2,
      modifiers: [
        { name: { fr: 'Poivre', ar: 'فلفل' }, priceDeltaCents: 300 },
        { name: { fr: 'Sans sauce' }, priceDeltaCents: -100 },
        { name: { fr: 'Nature' } }
      ],
      ...over
    })

    it('creates a group with its modifiers in order, deltas as given (a discount is negative)', () => {
      const id = ok(h.service.saveModifierGroup(h.manager, group())).id
      const [saved] = catalog().modifierGroups
      expect(saved).toMatchObject({ id, name: { fr: 'Sauce' }, minSelect: 0, maxSelect: 2 })
      expect(saved?.modifiers.map((m) => [m.name.fr, m.priceDeltaCents])).toEqual([
        ['Poivre', 300],
        ['Sans sauce', -100],
        ['Nature', 0]
      ])
      expect(h.eventRows().at(-1)).toMatchObject({ type: 'modifier_group.saved', entity: 'modifier_group', entity_id: id })
    })

    it('edits a group: keeps the modifiers it names by id, adds new ones, drops the others', () => {
      const id = ok(h.service.saveModifierGroup(h.manager, group())).id
      const [first, second] = catalog().modifierGroups[0]!.modifiers
      ok(
        h.service.saveModifierGroup(h.manager, {
          id,
          name: { fr: 'Sauces' },
          minSelect: 1,
          maxSelect: 1,
          modifiers: [{ name: { fr: 'Nouvelle' } }, { id: first!.id, name: { fr: 'Poivre noir' }, priceDeltaCents: 350 }]
        })
      )
      const saved = catalog().modifierGroups[0]!
      expect(saved).toMatchObject({ name: { fr: 'Sauces' }, minSelect: 1, maxSelect: 1 })
      expect(saved.modifiers.map((m) => m.name.fr)).toEqual(['Nouvelle', 'Poivre noir'])
      expect(saved.modifiers[1]).toEqual({ id: first!.id, name: { fr: 'Poivre noir' }, priceDeltaCents: 350 })
      expect(saved.modifiers.map((m) => m.id)).not.toContain(second!.id)
      expect(h.count('modifiers')).toBe(2)
    })

    it.each([
      ['no modifier', { modifiers: [] }, 'modifiers'],
      ['min above max', { minSelect: 3, maxSelect: 2 }, 'minSelect'],
      ['a max of 0', { minSelect: 0, maxSelect: 0 }, 'maxSelect'],
      ['a modifier without a name', { modifiers: [{ name: { fr: '' } }] }, 'modifiers.0.name.fr'],
      ['a fractional delta', { modifiers: [{ name: { fr: 'a' }, priceDeltaCents: 1.5 }] }, 'modifiers.0.priceDeltaCents'],
      ['an unknown modifier id', { modifiers: [{ id: 'nope', name: { fr: 'a' } }] }, 'modifiers.0.id']
    ])('refuses %s as invalid_input', (_why, over, field) => {
      const r = h.service.saveModifierGroup(h.manager, group(over))
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
      expect(h.count('modifier_groups')).toBe(0)
    })

    it('refuses to take over a modifier of another group', () => {
      ok(h.service.saveModifierGroup(h.manager, group()))
      const other = ok(h.service.saveModifierGroup(h.manager, group({ name: { fr: 'Autre' } }))).id
      const foreign = catalog().modifierGroups[0]!.modifiers[0]!.id
      const r = h.service.saveModifierGroup(h.manager, group({ id: other, modifiers: [{ id: foreign, name: { fr: 'x' } }] }))
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'modifiers.0.id' } } })
    })
  })

  describe('saveMenu', () => {
    it('creates a set menu with courses and items, and saving again replaces its courses', () => {
      const c = category()
      const menu = product(c, { name: { fr: 'Menu midi' }, priceCents: 9000 })
      const a = product(c, { name: { fr: 'Salade' } })
      const b = product(c, { name: { fr: 'Tajine' } })
      const id = ok(
        h.service.saveMenu(h.manager, {
          productId: menu,
          courses: [
            { name: { fr: 'Entrée' }, items: [{ productId: a }] },
            { name: { fr: 'Plat', ar: 'طبق' }, chooseCount: 1, items: [{ productId: b, supplementCents: 1500 }, { productId: a }] }
          ]
        })
      ).id
      const [saved] = catalog().menus
      expect(saved).toMatchObject({ id, productId: menu })
      expect(saved?.courses.map((x) => [x.name.fr, x.chooseCount, x.items])).toEqual([
        ['Entrée', 1, [{ productId: a, supplementCents: 0 }]],
        ['Plat', 1, [{ productId: b, supplementCents: 1500 }, { productId: a, supplementCents: 0 }]]
      ])

      const again = ok(h.service.saveMenu(h.manager, { productId: menu, courses: [{ name: { fr: 'Plat unique' }, items: [{ productId: b }] }] })).id
      expect(again).toBe(id)
      expect(h.count('menus')).toBe(1)
      expect(h.count('menu_courses')).toBe(1)
      expect(h.count('menu_course_items')).toBe(1)
      expect(h.eventRows().at(-1)).toMatchObject({ type: 'menu.saved', entity: 'menu', entity_id: id })
    })

    it.each<[string, (a: string, menu: string) => Record<string, unknown>, string]>([
      ['no course', () => ({ courses: [] }), 'courses'],
      ['a course without item', () => ({ courses: [{ name: { fr: 'x' }, items: [] }] }), 'courses.0.items'],
      ['an unknown item', () => ({ courses: [{ name: { fr: 'x' }, items: [{ productId: 'nope' }] }] }), 'courses.0.items.0.productId'],
      [
        'the menu product among its own items',
        (_a: string, menu: string) => ({ courses: [{ name: { fr: 'x' }, items: [{ productId: menu }] }] }),
        'courses.0.items.0.productId'
      ],
      [
        'the same item twice in a course',
        (a: string) => ({ courses: [{ name: { fr: 'x' }, items: [{ productId: a }, { productId: a }] }] }),
        'courses.0.items.1.productId'
      ],
      ['a choose count of 0', (a: string) => ({ courses: [{ name: { fr: 'x' }, chooseCount: 0, items: [{ productId: a }] }] }), 'courses.0.chooseCount'],
      [
        'a negative supplement',
        (a: string) => ({ courses: [{ name: { fr: 'x' }, items: [{ productId: a, supplementCents: -1 }] }] }),
        'courses.0.items.0.supplementCents'
      ]
    ])('refuses %s as invalid_input', (_why, make, field) => {
      const c = category()
      const menu = product(c, { name: { fr: 'Menu' } })
      const a = product(c, { name: { fr: 'Salade' } })
      const r = h.service.saveMenu(h.manager, { productId: menu, ...make(a, menu) } as MenuInput)
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
      expect(h.count('menus')).toBe(0)
    })

    it('refuses an unknown menu product', () => {
      const courses = [{ name: { fr: 'x' }, items: [{ productId: 'nope' }] }]
      const r = h.service.saveMenu(h.manager, { productId: 'nope', courses })
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'productId' } } })
    })
  })

  describe('reorder', () => {
    it('sets the order of categories, products and modifier groups from the list', () => {
      const [a, b, c] = ['A', 'B', 'C'].map((n) => category(n)) as [string, string, string]
      ok(h.service.reorder(h.manager, 'category', [c, a, b]))
      expect(catalog().categories.map((x) => x.name.fr)).toEqual(['C', 'A', 'B'])
      expect(catalog().categories.map((x) => x.sort)).toEqual([0, 1, 2])

      const p1 = product(a, { name: { fr: 'p1' } })
      const p2 = product(a, { name: { fr: 'p2' } })
      ok(h.service.reorder(h.manager, 'product', [p2, p1]))
      expect(catalog().products.map((x) => x.name.fr)).toEqual(['p2', 'p1'])

      const g1 = ok(h.service.saveModifierGroup(h.manager, { name: { fr: 'g1' }, modifiers: [{ name: { fr: 'm' } }] })).id
      const g2 = ok(h.service.saveModifierGroup(h.manager, { name: { fr: 'g2' }, modifiers: [{ name: { fr: 'm' } }] })).id
      ok(h.service.reorder(h.manager, 'modifierGroup', [g2, g1]))
      expect(catalog().modifierGroups.map((x) => x.name.fr)).toEqual(['g2', 'g1'])
      expect(h.eventRows().filter((e) => e.type === 'catalog.reordered')).toHaveLength(3)
    })

    it('refuses an unknown or repeated id, an unknown kind, and changes nothing', () => {
      const [a, b] = ['A', 'B'].map((n) => category(n)) as [string, string]
      expect(h.service.reorder(h.manager, 'category', [b, 'nope'])).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'ids' } } })
      expect(code(h.service.reorder(h.manager, 'category', [b, b]))).toBe('invalid_input')
      expect(code(h.service.reorder(h.manager, 'table' as never, [a]))).toBe('invalid_input')
      expect(catalog().categories.map((x) => x.id)).toEqual([a, b])
    })
  })

  describe('adjustStock', () => {
    it('adds the delta, logs delta, reason and new value, announces catalog.changed', () => {
      const c = category()
      const id = product(c, { stockTracked: true, stockMilli: 5000 })
      h.published.length = 0
      expect(ok(h.service.adjustStock(h.manager, id, -1500, ' casse '))).toEqual({ stockMilli: 3500 })
      expect(find(id).stockMilli).toBe(3500)
      const logged = h.eventRows().at(-1)!
      expect(logged).toMatchObject({ type: 'stock.adjusted', entity: 'product', entity_id: id, user_id: 'u-manager' })
      expect(JSON.parse(logged.data_json!)).toEqual({ deltaMilli: -1500, reason: 'casse', stockMilli: 3500 })
      expect(h.published).toEqual([{ type: 'catalog.changed' }])
    })

    it('lets the stock go negative (an oversold item), and adds fractions of a unit', () => {
      const c = category()
      const id = product(c, { stockTracked: true, stockMilli: 500 })
      expect(ok(h.service.adjustStock(h.manager, id, -1250, 'écart')).stockMilli).toBe(-750)
    })

    it.each([
      ['a missing reason', 1000, '  ', 'reason'],
      ['a zero delta', 0, 'x', 'deltaMilli'],
      ['a fractional delta', 1.5, 'x', 'deltaMilli']
    ])('refuses %s', (_why, delta, reason, field) => {
      const c = category()
      const id = product(c, { stockTracked: true })
      expect(h.service.adjustStock(h.manager, id, delta, reason)).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
      expect(find(id).stockMilli).toBe(0)
    })

    it('refuses a product that does not track its stock, and an unknown product', () => {
      const c = category()
      const id = product(c)
      expect(code(h.service.adjustStock(h.manager, id, 1000, 'x'))).toBe('stock_not_tracked')
      expect(h.service.adjustStock(h.manager, 'nope', 1000, 'x')).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'productId' } } })
    })
  })

  describe('quickCreateProduct', () => {
    it('creates a product at the standard VAT rate from a scanned barcode', () => {
      const c = category()
      const { id } = ok(h.service.quickCreateProduct(h.manager, ' 6111245591033 ', 'Biscuits', 1250, c))
      expect(find(id)).toMatchObject({
        categoryId: c,
        name: { fr: 'Biscuits' },
        barcode: '6111245591033',
        priceCents: 1250,
        vatBp: 2000,
        active: true
      })
      expect(h.eventRows().at(-1)).toMatchObject({ type: 'product.quick_created', entity_id: id })
      expect(h.published.at(-1)).toEqual({ type: 'catalog.changed' })
    })

    it('refuses a barcode already used, a blank name, a bad price and an unknown category', () => {
      const c = category()
      ok(h.service.quickCreateProduct(h.manager, '611', 'A', 100, c))
      expect(code(h.service.quickCreateProduct(h.manager, '611', 'B', 100, c))).toBe('barcode_taken')
      expect(h.service.quickCreateProduct(h.manager, '612', ' ', 100, c)).toMatchObject({ ok: false, error: { params: { field: 'name.fr' } } })
      expect(h.service.quickCreateProduct(h.manager, '612', 'B', -5, c)).toMatchObject({ ok: false, error: { params: { field: 'priceCents' } } })
      expect(h.service.quickCreateProduct(h.manager, '612', 'B', 100, 'nope')).toMatchObject({ ok: false, error: { params: { field: 'categoryId' } } })
      expect(h.service.quickCreateProduct(h.manager, '', 'B', 100, c)).toMatchObject({ ok: false, error: { params: { field: 'barcode' } } })
      expect(h.count('products')).toBe(1)
    })
  })

  describe('listCatalog', () => {
    it('lists everything in display order, inactive items included', () => {
      const c1 = category('A')
      const c2 = category('B')
      product(c2, { name: { fr: 'b1' } })
      const a1 = product(c1, { name: { fr: 'a1' }, active: false })
      expect(catalog().categories.map((x) => x.name.fr)).toEqual(['A', 'B'])
      expect(catalog().products.map((x) => x.name.fr)).toEqual(['b1', 'a1'])
      expect(find(a1).active).toBe(false)
    })
  })

  it('everything the use cases write can be exported as a setup profile', () => {
    const c = category('Plats')
    const drinks = category('Boissons')
    const g = ok(
      h.service.saveModifierGroup(h.manager, {
        name: { fr: 'Sauce', ar: 'صلصة' },
        minSelect: 0,
        maxSelect: 2,
        modifiers: [{ name: { fr: 'Poivre' }, priceDeltaCents: 300 }, { name: { fr: 'Sans', ar: ' ' }, priceDeltaCents: -100 }]
      })
    ).id
    const dish = product(c, { name: { fr: 'Tajine', ar: 'طاجين', en: ' ' }, barcode: '611', color: '#d64545', modifierGroupIds: [g], course: 2, keySize: 2 })
    const salad = product(c, { name: { fr: 'Salade' }, priceCents: 0, vatBp: 1000, soldByWeight: true, stockTracked: true, stockMilli: 2500, lowStockMilli: 500 })
    const menu = product(drinks, { name: { fr: 'Menu midi' }, priceCents: 9000, active: false })
    ok(
      h.service.saveMenu(h.manager, {
        productId: menu,
        courses: [{ name: { fr: 'Plat', ar: 'طبق' }, chooseCount: 1, items: [{ productId: dish, supplementCents: 0 }, { productId: salad, supplementCents: 500 }] }]
      })
    )
    ok(h.service.quickCreateProduct(h.manager, '999', 'Chips', 350, drinks))
    insertOrderLine(h.t.db, salad)
    ok(h.service.deleteProduct(h.manager, salad))

    const profile = readProfile(exportProfile(h.t.db))
    expect(profile.ok).toBe(true)
    if (!profile.ok) return
    expect(profile.value.catalog.products.map((p) => p.name.fr)).toEqual(['Tajine', 'Salade', 'Menu midi', 'Chips'])
    expect(profile.value.catalog.menus).toHaveLength(1)
    expect(profile.value.catalog.modifierGroups[0]?.modifiers.map((m) => m.price_delta_cents)).toEqual([300, -100])
  })
})
