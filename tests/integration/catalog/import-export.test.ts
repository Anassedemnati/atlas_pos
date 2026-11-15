import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { ImportRow } from '../../../src/shared/dto'
import type { Result } from '../../../src/shared/result'
import { parseCatalogSheet } from '../../../src/main/infrastructure/import/catalog-sheet'
import { catalogHarness, insertOrderLine, type CatalogHarness } from '../../helpers/catalog'
import { HEADER, SAMPLE, csvBuffer } from '../../helpers/sheets'

const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)
function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

const parseOk = (buf: Buffer, name: string, rates?: number[]): ImportRow[] => {
  const { rows, errors } = parseCatalogSheet(buf, name, rates)
  expect(errors).toEqual([])
  return rows
}
const sampleRows = (): ImportRow[] => parseOk(csvBuffer(SAMPLE), 'c.csv')

/** Rows without their sheet position: the content of a catalogue. */
const content = (rows: ImportRow[]): Omit<ImportRow, 'row'>[] => rows.map(({ row: _row, ...rest }) => rest)

describe('catalog import and export', () => {
  let h: CatalogHarness
  beforeEach(() => {
    h = catalogHarness()
  })
  afterEach(() => h.cleanup())

  const catalog = () => h.service.listCatalog()
  const names = () => catalog().products.map((p) => p.name.fr)
  const productByName = (fr: string) => {
    const p = catalog().products.find((x) => x.name.fr === fr)
    if (!p) throw new Error(`no product ${fr}`)
    return p
  }
  const categoryName = (id: string) => catalog().categories.find((c) => c.id === id)?.name.fr

  describe('merge', () => {
    it('creates the categories by name_fr, the products in file order, and reports the counts', () => {
      const summary = ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      expect(summary).toEqual({ mode: 'merge', categoriesCreated: 2, created: 3, updated: 0, deleted: 0, deactivated: 0 })
      expect(catalog().categories.map((c) => [c.name.fr, c.color, c.sort, c.active])).toEqual([
        ['Boissons', '#0FA3A3', 0, true],
        ['Épicerie', '#0FA3A3', 1, true]
      ])
      expect(names()).toEqual(['Eau minérale 1,5 L', 'Café noir', 'Sucre en vrac'])
      expect(productByName('Eau minérale 1,5 L')).toMatchObject({
        name: { fr: 'Eau minérale 1,5 L', ar: 'ماء معدني', en: 'Mineral water 1.5 L' },
        priceCents: 750,
        vatBp: 2000,
        barcode: '6111245591033',
        soldByWeight: false,
        stockTracked: true,
        stockMilli: 24000,
        color: '#0FA3A3',
        active: true,
        keySize: 1,
        course: 0
      })
      expect(productByName('Café noir')).toMatchObject({ stockTracked: false, stockMilli: 0, barcode: null, color: null })
      expect(productByName('Sucre en vrac')).toMatchObject({ soldByWeight: true, stockMilli: 12500, sort: 2 })
    })

    it('logs one catalog.imported event and announces catalog.changed once', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      expect(h.eventRows()).toHaveLength(1)
      expect(h.eventRows()[0]).toMatchObject({ type: 'catalog.imported', entity: 'catalog', user_id: 'u-manager' })
      expect(JSON.parse(h.eventRows()[0]!.data_json!)).toMatchObject({ mode: 'merge', created: 3, categoriesCreated: 2 })
      expect(h.published).toEqual([{ type: 'catalog.changed' }])
    })

    it('reuses an existing category whatever the case and spacing of its name', () => {
      const id = ok(h.service.saveCategory(h.manager, { name: { fr: 'Boissons' }, color: '#14213D' })).id
      const rows = parseOk(csvBuffer([SAMPLE[0]!.map((v, i) => (i === 0 ? '  BOISSONS ' : v))]), 'c.csv')
      const summary = ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(summary.categoriesCreated).toBe(0)
      expect(catalog().categories).toHaveLength(1)
      expect(catalog().products[0]?.categoryId).toBe(id)
    })

    it('updates a product found by barcode, and one found by name, creating nothing', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const rows = parseOk(
        csvBuffer([
          // same barcode, new name and price
          ['Boissons', 'Eau plate', '', '', '9', '20', '6111245591033', 'non', '', ''],
          // same category and name, no barcode: found by name
          ['Boissons', 'Café noir', '', '', '15', '10', '', 'non', '', '']
        ]),
        'c.csv'
      )
      const summary = ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(summary).toMatchObject({ created: 0, updated: 2 })
      expect(names()).toEqual(['Eau plate', 'Café noir', 'Sucre en vrac'])
      expect(productByName('Eau plate').priceCents).toBe(900)
      expect(productByName('Café noir').priceCents).toBe(1500)
    })

    it('keeps what the sheet leaves empty (Arabic name, barcode, colour, stock) and what it has no column for', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const eau = productByName('Eau minérale 1,5 L')
      const id = ok(
        h.service.saveProduct(h.manager, { id: eau.id, categoryId: eau.categoryId, name: eau.name, priceCents: 750, vatBp: 2000, keySize: 3, course: 2 })
      ).id
      const rows = parseOk(csvBuffer([['Boissons', 'Eau minérale 1,5 L', '', '', '8', '20', '', 'non', '', '']]), 'c.csv')
      ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(catalog().products.find((p) => p.id === id)).toMatchObject({
        name: { fr: 'Eau minérale 1,5 L', ar: 'ماء معدني', en: 'Mineral water 1.5 L' },
        priceCents: 800,
        barcode: '6111245591033',
        color: '#0FA3A3',
        stockTracked: true,
        stockMilli: 24000,
        keySize: 3,
        course: 2
      })
    })

    it.each(['merge', 'replace'] as const)(
      'keeps the live stock of a tracked product, however old the sheet is (%s), and starts a product that was not tracked',
      (mode) => {
        ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
        const eau = productByName('Eau minérale 1,5 L')
        ok(h.service.adjustStock(h.manager, eau.id, -5000, 'vente du matin'))
        const cafe = productByName('Café noir')
        const rows = parseOk(
          csvBuffer([
            // sheet written before the sales: still says 24
            SAMPLE[0]!,
            // never tracked, now has a stock cell: starts at 7
            ['Boissons', 'Café noir', '', '', '12', '10', '', 'non', '7', '']
          ]),
          'c.csv'
        )
        ok(h.service.applyCatalogImport(h.manager, rows, mode))
        expect(productByName('Eau minérale 1,5 L').stockMilli).toBe(19000)
        expect(productByName('Café noir')).toMatchObject({ id: cafe.id, stockTracked: true, stockMilli: 7000 })
      }
    )

    it('moves a product to another category, reactivates a product and a category that were off', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const eau = productByName('Eau minérale 1,5 L')
      ok(h.service.saveProduct(h.manager, { id: eau.id, categoryId: eau.categoryId, name: eau.name, priceCents: 750, vatBp: 2000, active: false }))
      const epicerie = catalog().categories.find((c) => c.name.fr === 'Épicerie')!
      ok(h.service.saveCategory(h.manager, { id: epicerie.id, name: epicerie.name, active: false }))
      // found by its barcode, so the category of the sheet is where it goes
      const rows = parseOk(csvBuffer([['Épicerie', 'Eau minérale 1,5 L', '', '', '7,50', '20', '6111245591033', 'non', '', '']]), 'c.csv')
      ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(categoryName(productByName('Eau minérale 1,5 L').categoryId)).toBe('Épicerie')
      expect(productByName('Eau minérale 1,5 L')).toMatchObject({ id: eau.id, active: true })
      expect(catalog().categories.find((c) => c.id === epicerie.id)?.active).toBe(true)
      expect(catalog().products).toHaveLength(3)
    })

    it('adds a barcode to an existing product found by name, and never gives one barcode to two products', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const rows = parseOk(
        csvBuffer([
          ['Boissons', 'Café noir', '', '', '12', '10', '777', 'non', '', ''],
          ['Boissons', 'Café noir', '', '', '13', '10', '778', 'non', '', '']
        ]),
        'c.csv'
      )
      ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(catalog().products.filter((p) => p.name.fr === 'Café noir').map((p) => p.barcode).sort()).toEqual(['777', '778'])
      expect(h.count('products')).toBe(4)
    })

    it('imports twice without duplicating anything', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const before = catalog()
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      expect(catalog()).toEqual(before)
    })

    it('appends new products after the existing ones', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const rows = parseOk(csvBuffer([['Snacks', 'Chips', '', '', '3,5', '20', '', '', '', '']]), 'c.csv')
      ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(productByName('Chips').sort).toBe(3)
      expect(catalog().categories.at(-1)).toMatchObject({ name: { fr: 'Snacks' }, sort: 2 })
    })
  })

  describe('replace', () => {
    it('removes what the file does not list: deleted when never used, inactive when used or in a menu', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const extras = ok(h.service.saveCategory(h.manager, { name: { fr: 'Rayon vide' } })).id
      const cafe = productByName('Café noir')
      const sold = ok(h.service.saveProduct(h.manager, { categoryId: cafe.categoryId, name: { fr: 'Vendu' }, priceCents: 100, vatBp: 0 })).id
      insertOrderLine(h.t.db, sold)
      const free = ok(h.service.saveProduct(h.manager, { categoryId: cafe.categoryId, name: { fr: 'Jamais vendu' }, priceCents: 100, vatBp: 0 })).id
      const sugar = productByName('Sucre en vrac')
      ok(h.service.saveMenu(h.manager, { productId: sugar.id, courses: [{ name: { fr: 'x' }, items: [{ productId: free }] }] }))

      const rows = parseOk(csvBuffer([SAMPLE[0]!]), 'c.csv')
      const summary = ok(h.service.applyCatalogImport(h.manager, rows, 'replace'))
      // Café noir, Vendu, Jamais vendu, Sucre en vrac are not in the file; Sucre has a menu (deleted with it), Jamais vendu is in that menu.
      expect(summary).toMatchObject({ mode: 'replace', created: 0, updated: 1, deleted: 2, deactivated: 2 })
      const left = new Map(catalog().products.map((p) => [p.name.fr, p.active]))
      expect(left).toEqual(
        new Map([
          ['Eau minérale 1,5 L', true],
          ['Vendu', false],
          ['Jamais vendu', false]
        ])
      )
      // the menu product was never sold: it is deleted with its menu, and the item it listed stays (inactive)
      expect(h.count('menus')).toBe(0)
      expect(h.count('menu_course_items')).toBe(0)
      // Boissons stays (holds inactive products, now off); Épicerie and the empty one are deleted
      const categories = new Map(catalog().categories.map((c) => [c.name.fr, c.active]))
      expect(categories).toEqual(new Map([['Boissons', true]]))
      expect(catalog().categories.some((c) => c.id === extras)).toBe(false)
    })

    it('takes the file as the whole truth for the products it lists: empty cells clear, file order sorts', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const rows = parseOk(
        csvBuffer([
          ['Épicerie', 'Sucre en vrac', '', '', '8', '7', '', 'oui', '', ''],
          ['Boissons', 'Eau minérale 1,5 L', '', '', '7,5', '20', '', 'non', '', '']
        ]),
        'c.csv'
      )
      ok(h.service.applyCatalogImport(h.manager, rows, 'replace'))
      expect(productByName('Eau minérale 1,5 L')).toMatchObject({
        name: { fr: 'Eau minérale 1,5 L' },
        barcode: null,
        color: null,
        stockTracked: false
      })
      expect(catalog().categories.map((c) => c.name.fr)).toEqual(['Épicerie', 'Boissons'])
      expect(names()).toEqual(['Sucre en vrac', 'Eau minérale 1,5 L'])
    })

    it('reactivates a product that was inactive and is in the file', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const eau = productByName('Eau minérale 1,5 L')
      insertOrderLine(h.t.db, eau.id)
      ok(h.service.deleteProduct(h.manager, eau.id))
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'replace'))
      expect(productByName('Eau minérale 1,5 L').active).toBe(true)
      expect(h.count('products')).toBe(3)
    })
  })

  describe('replace: the audit row', () => {
    const lastImport = () => JSON.parse(h.eventRows().filter((e) => e.type === 'catalog.imported').at(-1)!.data_json!)

    it('names the products it deleted and the ones it deactivated', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      expect(lastImport()).not.toHaveProperty('deletedNames')
      const cafe = productByName('Café noir')
      insertOrderLine(h.t.db, cafe.id)
      ok(h.service.applyCatalogImport(h.manager, parseOk(csvBuffer([SAMPLE[0]!]), 'c.csv'), 'replace'))
      expect(lastImport()).toMatchObject({
        mode: 'replace',
        deleted: 1,
        deactivated: 1,
        deletedNames: ['Sucre en vrac'],
        deactivatedNames: ['Café noir']
      })
    })

    it('lists 200 names at most per kind, and still counts them all', () => {
      const many = Array.from({ length: 250 }, (_, i) => ['Stock', `Article ${i}`, '', '', '1', '20', '', '', '', ''])
      ok(h.service.applyCatalogImport(h.manager, parseOk(csvBuffer(many), 'c.csv'), 'merge'))
      ok(h.service.applyCatalogImport(h.manager, parseOk(csvBuffer([SAMPLE[0]!]), 'c.csv'), 'replace'))
      const data = lastImport()
      expect(data.deleted).toBe(250)
      expect(data.deletedNames).toHaveLength(200)
      expect(data.deletedNames[0]).toBe('Article 0')
      expect(data.deactivatedNames).toEqual([])
    })
  })

  describe('VAT rates (the vat.rates setting)', () => {
    const odd = (): ImportRow[] => parseOk(csvBuffer([row550()]), 'c.csv', [2000, 550, 0])
    const row550 = (): string[] => ['Boissons', 'Eau', '', '', '5', '5,5', '611', '', '', '']

    it('applies a rate of the setting, and refuses it while the setting does not have it', () => {
      const rows = odd()
      expect(rows[0]?.vatBp).toBe(550)
      expect(h.service.applyCatalogImport(h.manager, rows, 'merge')).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { field: 'rows.0.vatBp', row: 2 } }
      })
      expect(h.count('products')).toBe(0)
      h.setVatRates([2000, 550, 0])
      ok(h.service.applyCatalogImport(h.manager, rows, 'merge'))
      expect(productByName('Eau').vatBp).toBe(550)
    })

    it.each([
      ['csv', 'a.csv'],
      ['xlsx', 'a.xlsx']
    ] as const)('writes 5,5 for a rate of 550 and reads it back (%s)', (format, fileName) => {
      h.setVatRates([2000, 550, 0])
      ok(h.service.applyCatalogImport(h.manager, odd(), 'merge'))
      const exported = h.service.exportCatalogSheet(format)
      if (format === 'csv') expect(exported.toString('utf8')).toContain(';5,00;5,5;611;')
      expect(parseOk(exported, fileName, [2000, 550, 0])[0]?.vatBp).toBe(550)
      // read with the default rates, the same file has an error on `tva`
      expect(parseCatalogSheet(exported, fileName).errors).toEqual([
        { row: 2, field: 'tva', messageKey: 'errors.import_invalid_vat' }
      ])
    })
  })

  describe('all or nothing', () => {
    const snapshot = () => ({
      categories: h.count('categories'),
      products: h.count('products'),
      events: h.eventRows().length,
      published: h.published.length
    })

    it('an import with an invalid row commits nothing, not even the rows before it', () => {
      const good = sampleRows()
      const bad = [...good, { ...good[0]!, row: 5, nameFr: 'Autre', barcode: undefined, vatBp: 1500 }]
      const before = snapshot()
      const r = h.service.applyCatalogImport(h.manager, bad, 'merge')
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'rows.3.vatBp', row: 5 } } })
      expect(snapshot()).toEqual(before)
    })

    it.each([
      ['a bad colour', { color: 'red' }, 'color'],
      ['a bad barcode', { barcode: 'a b' }, 'barcode'],
      ['a negative price', { priceCents: -1 }, 'priceCents'],
      ['a missing category', { category: ' ' }, 'category'],
      ['a missing French name', { nameFr: '' }, 'nameFr'],
      ['a negative stock', { stockMilli: -5 }, 'stockMilli'],
      ['an unknown field', { extra: 1 }, 'extra']
    ])('revalidates the rows it is given: %s', (_why, over, field) => {
      const rows = [{ ...sampleRows()[0]!, ...over }]
      const r = h.service.applyCatalogImport(h.manager, rows, 'merge')
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: `rows.0.${field}` } } })
      expect(h.count('products')).toBe(0)
    })

    it('refuses a barcode repeated in the rows, no rows, too many rows, and an unknown mode', () => {
      const [a] = sampleRows() as [ImportRow]
      expect(h.service.applyCatalogImport(h.manager, [a, { ...a, row: 3, nameFr: 'B' }], 'merge')).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { field: 'rows.1.barcode' } }
      })
      expect(code(h.service.applyCatalogImport(h.manager, [], 'replace'))).toBe('invalid_input')
      const many = Array.from({ length: 5001 }, (_, i) => ({ ...a, row: i + 2, nameFr: `P${i}`, barcode: undefined }))
      expect(code(h.service.applyCatalogImport(h.manager, many, 'merge'))).toBe('import_too_large')
      expect(code(h.service.applyCatalogImport(h.manager, [a], 'wipe' as never))).toBe('invalid_input')
      expect(h.count('products')).toBe(0)
    })

    it('rolls everything back when the database fails halfway', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows().slice(0, 1), 'merge'))
      h.t.db.exec(
        `CREATE TRIGGER boom BEFORE INSERT ON products WHEN NEW.price_cents = 99999
         BEGIN SELECT RAISE(ABORT, 'boom'); END`
      )
      const before = snapshot()
      const rows = parseOk(
        csvBuffer([
          ['Boissons', 'Premier', '', '', '5', '20', '', '', '', ''],
          ['Nouvelle', 'Dernier', '', '', '999,99', '20', '', '', '', '']
        ]),
        'c.csv'
      )
      expect(() => h.service.applyCatalogImport(h.manager, rows, 'replace')).toThrow(/boom/)
      expect(snapshot()).toEqual(before)
      expect(names()).toEqual(['Eau minérale 1,5 L'])
      expect(catalog().products[0]?.active).toBe(true)
    })
  })

  describe('export', () => {
    it('writes a CSV with the import columns: BOM, semicolons, CRLF, "70,00" prices, oui/non', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const buf = h.service.exportCatalogSheet('csv')
      expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      const lines = buf.toString('utf8').slice(1).split('\r\n')
      expect(lines[0]).toBe(HEADER.join(';'))
      expect(lines[1]).toBe('Boissons;Eau minérale 1,5 L;ماء معدني;Mineral water 1.5 L;7,50;20;6111245591033;non;24;#0FA3A3')
      expect(lines[2]).toBe('Boissons;Café noir;قهوة;;12,00;10;;non;;')
      expect(lines[3]).toBe('Épicerie;Sucre en vrac;;;8,00;7;;oui;12,5;')
      expect(lines[4]).toBe('')
    })

    it('writes an XLSX whose first sheet has the same cells as text', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const wb = XLSX.read(h.service.exportCatalogSheet('xlsx'), { type: 'buffer' })
      const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true })
      expect(aoa[0]).toEqual(HEADER)
      expect(aoa[1]).toEqual(['Boissons', 'Eau minérale 1,5 L', 'ماء معدني', 'Mineral water 1.5 L', '7,50', '20', '6111245591033', 'non', '24', '#0FA3A3'])
    })

    it('lists the products the till shows: active, in an active category, in display order', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      const cafe = productByName('Café noir')
      ok(h.service.saveProduct(h.manager, { id: cafe.id, categoryId: cafe.categoryId, name: cafe.name, priceCents: 1200, vatBp: 1000, active: false }))
      const epicerie = catalog().categories.find((c) => c.name.fr === 'Épicerie')!
      ok(h.service.saveCategory(h.manager, { id: epicerie.id, name: epicerie.name, active: false }))
      const rows = parseOk(h.service.exportCatalogSheet('csv'), 'c.csv')
      expect(rows.map((r) => r.nameFr)).toEqual(['Eau minérale 1,5 L'])
    })

    it('writes an oversold (negative) stock as 0', () => {
      ok(h.service.applyCatalogImport(h.manager, sampleRows(), 'merge'))
      ok(h.service.adjustStock(h.manager, productByName('Eau minérale 1,5 L').id, -30000, 'écart'))
      expect(parseOk(h.service.exportCatalogSheet('csv'), 'c.csv')[0]?.stockMilli).toBe(0)
    })

    it('exports an empty catalogue as a header only', () => {
      expect(h.service.exportCatalogSheet('csv').toString('utf8')).toBe(`﻿${HEADER.join(';')}\r\n`)
      expect(parseCatalogSheet(h.service.exportCatalogSheet('xlsx'), 'c.xlsx')).toEqual({ rows: [], errors: [] })
    })
  })

  describe('round trip', () => {
    it.each([
      ['csv', 'catalogue.csv'],
      ['xlsx', 'catalogue.xlsx']
    ] as const)('an export read back gives the rows that were imported (%s)', (format, fileName) => {
      const original = sampleRows()
      ok(h.service.applyCatalogImport(h.manager, original, 'merge'))
      const exported = h.service.exportCatalogSheet(format)
      expect(parseOk(exported, fileName)).toEqual(original)

      // and a second installation that imports that export ends with the same catalogue
      const other = catalogHarness()
      try {
        ok(other.service.applyCatalogImport(other.manager, parseOk(exported, fileName), 'merge'))
        expect(other.service.exportCatalogSheet(format).toString('hex')).toBe(exported.toString('hex'))
        const strip = (c: ReturnType<typeof catalog>) => ({
          categories: c.categories.map(({ id: _id, ...rest }) => rest),
          products: c.products.map(({ id: _id, categoryId, ...rest }) => ({ ...rest, category: c.categories.find((x) => x.id === categoryId)?.name.fr }))
        })
        expect(strip(other.service.listCatalog())).toEqual(strip(catalog()))
      } finally {
        other.cleanup()
      }
    })

    it('keeps texts that look like formulas or numbers, in both formats', () => {
      const lines = [
        ['=Cat', '=1+1', '+212', '@x', '7', '20', '0012345', 'non', '', ''],
        ['=Cat', "'=déjà", '-- Divers --', '', '1', '0', '-5', 'oui', '3', '']
      ]
      const original = parseOk(csvBuffer(lines), 'c.csv')
      ok(h.service.applyCatalogImport(h.manager, original, 'merge'))
      for (const [format, fileName] of [['csv', 'a.csv'], ['xlsx', 'a.xlsx']] as const) {
        expect(content(parseOk(h.service.exportCatalogSheet(format), fileName))).toEqual(content(original))
      }
      const csv = h.service.exportCatalogSheet('csv').toString('utf8')
      expect(csv).toContain(";'=1+1;")
      expect(csv).toContain("\r\n'=Cat;'=1+1;")
    })
  })
})
