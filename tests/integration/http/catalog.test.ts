import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogDto, ImportSummary } from '../../../src/shared/dto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { csvBuffer, SAMPLE } from '../../helpers/sheets'
import { body, startHttp, type Http } from './harness'

let h: Http
beforeAll(async () => {
  h = await startHttp()
  expect((await h.login()).statusCode).toBe(200)
})
afterAll(async () => {
  await h.close()
})

const catalog = async (): Promise<CatalogDto> => body<{ value: CatalogDto }>(await h.api('GET', '/api/catalog')).value

describe('products over HTTP', () => {
  it('creates a product, which the till is told about (catalog.changed) and lists', async () => {
    const before = await catalog()
    const categoryId = before.categories[0]!.id
    h.events.length = 0
    const created = await h.api('POST', '/api/catalog/products', {
      categoryId,
      name: { fr: 'Pastilla', ar: 'بسطيلة', en: 'Pastilla' },
      priceCents: 8500,
      vatBp: 1000,
      barcode: '6111000000017',
      color: '#0FA3A3'
    })
    expect(created.statusCode).toBe(200)
    const { id } = body<{ value: { id: string } }>(created).value
    expect(h.events.filter((e) => e.type === 'catalog.changed')).toHaveLength(1)
    const after = await catalog()
    expect(after.products.find((p) => p.id === id)).toMatchObject({ name: { fr: 'Pastilla', ar: 'بسطيلة' }, priceCents: 8500, vatBp: 1000, barcode: '6111000000017', categoryId })

    // Edit by id (the URL wins), then deactivate, then delete (never sold: really deleted).
    const renamed = await h.api('PUT', `/api/catalog/products/${id}`, { categoryId, name: { fr: 'Pastilla poulet' }, priceCents: 9000, vatBp: 1000 })
    expect(renamed.statusCode).toBe(200)
    expect((await catalog()).products.find((p) => p.id === id)).toMatchObject({ name: { fr: 'Pastilla poulet' }, priceCents: 9000 })
    const removed = await h.api('DELETE', `/api/catalog/products/${id}`)
    expect(body(removed)).toMatchObject({ ok: true, value: { outcome: 'deleted' } })
    expect((await catalog()).products.some((p) => p.id === id)).toBe(false)
  })

  it('refuses a bad product with 400 and the offending field', async () => {
    const categoryId = (await catalog()).categories[0]!.id
    const response = await h.api('POST', '/api/catalog/products', { categoryId, name: { fr: 'Trop cher' }, priceCents: 1.5, vatBp: 1000 })
    expect(response.statusCode).toBe(400)
    expect(body(response)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect((await h.api('POST', '/api/catalog/products', { categoryId, name: { fr: 'TVA inconnue' }, priceCents: 100, vatBp: 1234 })).statusCode).toBe(400)
  })

  it('reorders categories and tells the till', async () => {
    const before = await catalog()
    const ids = before.categories.map((c) => c.id).reverse()
    h.events.length = 0
    expect((await h.api('POST', '/api/catalog/reorder', { kind: 'category', ids })).statusCode).toBe(200)
    expect((await catalog()).categories.map((c) => c.id)).toEqual(ids)
    expect(h.events.some((e) => e.type === 'catalog.changed')).toBe(true)
  })
})

describe('the import over HTTP', () => {
  const upload = (bytes: Buffer, name = 'produits.csv') => h.upload('/api/catalog/import/preview', bytes, { 'x-file-name': encodeURIComponent(name) })

  it('previews a sheet with bad rows (200 with the errors); applying it is refused and adds nothing', async () => {
    const before = (await catalog()).products.length
    const bad = csvBuffer([...SAMPLE, ['Boissons', 'Jus', '', '', 'abc', '10', '', 'non', '', '']])
    const preview = await upload(bad)
    expect(preview.statusCode).toBe(200)
    const value = body<{ value: { previewId: string; rows: unknown[]; errors: { row: number; field: string }[] } }>(preview).value
    expect(value.rows).toHaveLength(3)
    expect(value.errors).toMatchObject([{ row: 5, field: 'prix' }])
    const apply = await h.api('POST', '/api/catalog/import/apply', { previewId: value.previewId, mode: 'merge' })
    expect(apply.statusCode).toBe(409)
    expect(body(apply)).toMatchObject({ ok: false, error: { code: 'has_errors' } })
    // Rows sent by the browser are never read: only a preview id.
    expect((await h.api('POST', '/api/catalog/import/apply', { rows: [], mode: 'merge' })).statusCode).toBe(400)
    expect((await catalog()).products).toHaveLength(before)
  })

  it('applies a clean sheet', async () => {
    const before = (await catalog()).products.length
    const preview = body<{ value: { previewId: string; errors: unknown[] } }>(await upload(csvBuffer(SAMPLE))).value
    expect(preview.errors).toEqual([])
    h.events.length = 0
    const apply = await h.api('POST', '/api/catalog/import/apply', { previewId: preview.previewId, mode: 'merge' })
    expect(apply.statusCode).toBe(200)
    expect(body<{ value: ImportSummary }>(apply).value).toMatchObject({ created: 3 })
    expect((await catalog()).products).toHaveLength(before + 3)
    expect(h.events.some((e) => e.type === 'catalog.changed')).toBe(true)
    // A preview is used once.
    expect((await h.api('POST', '/api/catalog/import/apply', { previewId: preview.previewId, mode: 'merge' })).statusCode).toBe(400)
  })

  it('refuses an empty body and a file that is not a sheet', async () => {
    expect((await h.upload('/api/catalog/import/preview', new Uint8Array(0))).statusCode).toBe(400)
    const preview = await upload(Buffer.from('not,a,sheet\n1,2,3'))
    expect(preview.statusCode).toBe(200)
    expect(body<{ value: { errors: unknown[] } }>(preview).value.errors.length).toBeGreaterThan(0)
  })

  it('exports the catalogue as CSV and XLSX', async () => {
    const csv = await h.api('GET', '/api/catalog/export?format=csv')
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.headers['content-disposition']).toContain('catalogue.csv')
    expect(csv.body).toContain('Café noir')
    const xlsx = await h.api('GET', '/api/catalog/export?format=xlsx')
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK')
    expect((await h.api('GET', '/api/catalog/export?format=pdf')).statusCode).toBe(400)
  })
})

describe('product photos', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

  it('stores a photo under media/products with a name of its own, and serves it back to a signed-in browser only', async () => {
    const response = await h.upload('/api/media/products', PNG, { 'x-file-name': '../../etc/passwd.png' })
    expect(response.statusCode).toBe(200)
    const { imagePath } = body<{ value: { imagePath: string } }>(response).value
    expect(imagePath).toMatch(/^media\/products\/[0-9a-f-]{36}\.png$/)
    expect(readFileSync(join(h.paths.root, imagePath))).toEqual(PNG)
    const served = await h.api('GET', `/${imagePath}`)
    expect(served.statusCode).toBe(200)
    expect(served.headers['content-type']).toBe('image/png')
    expect((await h.app.inject({ method: 'GET', url: `/${imagePath}` })).statusCode).toBe(401)
    expect((await h.api('GET', '/media/..%2f..%2fdb%2fatlas.db')).statusCode).toBe(404)
  })

  it('judges the type by the first bytes, and caps the size', async () => {
    mkdirSync(h.paths.media, { recursive: true })
    const text = await h.upload('/api/media/products', Buffer.from('<svg onload=alert(1)/>'), { 'content-type': 'application/octet-stream' })
    expect(text.statusCode).toBe(415)
    expect(body(text)).toMatchObject({ error: { code: 'unsupported_media' } })
    const big = await h.upload('/api/media/products', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))
    expect(big.statusCode).toBe(413)
    const jpeg = await h.upload('/api/media/products', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    expect(body<{ value: { imagePath: string } }>(jpeg).value.imagePath).toMatch(/\.jpg$/)
  })
})

describe('settings', () => {
  it('changes the receipt texts in one transaction and tells the till', async () => {
    h.events.length = 0
    const response = await h.api('PUT', '/api/settings', { changes: { 'receipt.footer': 'À bientôt !', 'receipt.header': 'Bienvenue' } })
    expect(response.statusCode).toBe(200)
    const settings = body<{ value: { values: Record<string, unknown>; technicianOnly: string[] } }>(await h.api('GET', '/api/settings')).value
    expect(settings.values).toMatchObject({ 'receipt.footer': 'À bientôt !', 'receipt.header': 'Bienvenue' })
    expect(settings.values).not.toHaveProperty('tech.codeHash')
    expect(settings.technicianOnly).toEqual(expect.arrayContaining(['vat.rates', 'backoffice.port', 'kiosk.enabled']))
    expect(h.events.find((e) => e.type === 'settings.changed')).toMatchObject({ keys: expect.arrayContaining(['receipt.footer']) })
  })

  it('refuses technician-only keys and the technician code, and changes nothing when one value is bad', async () => {
    for (const key of ['vat.rates', 'backoffice.port', 'kiosk.enabled', 'modules']) {
      const response = await h.api('PUT', '/api/settings', { changes: { [key]: key === 'vat.rates' ? [2000] : true } })
      expect(response.statusCode, key).toBe(403)
    }
    expect((await h.api('PUT', '/api/settings', { changes: { 'tech.codeHash': 'x' } })).statusCode).toBe(400)
    expect((await h.api('PUT', '/api/settings', { changes: { 'unknown.key': 1 } })).statusCode).toBe(400)
    const mixed = await h.api('PUT', '/api/settings', { changes: { 'receipt.footer': 'Changé', 'till.autoLockSeconds': -5 } })
    expect(mixed.statusCode).toBe(400)
    const values = body<{ value: { values: Record<string, unknown> } }>(await h.api('GET', '/api/settings')).value.values
    expect(values['receipt.footer']).toBe('À bientôt !')
  })
})

describe('users', () => {
  it('lists the staff without any secret, and creates a user (password of 8 characters at least)', async () => {
    const staff = body<{ value: { users: Record<string, unknown>[]; profiles: { id: string; name: { fr: string } }[] } }>(await h.api('GET', '/api/users')).value
    expect(staff.users.map((u) => u['displayName'])).toEqual(['Karim', 'Sara', 'Youssef'])
    expect(JSON.stringify(staff)).not.toMatch(/hash|scrypt/i)
    const caissier = staff.profiles.find((p) => p.name.fr === 'Caissier')!
    const short = await h.api('POST', '/api/users', { displayName: 'Nadia', profileId: caissier.id, pin: '4567', username: 'nadia', password: 'short' })
    expect(short.statusCode).toBe(400)
    const created = await h.api('POST', '/api/users', { displayName: 'Nadia', profileId: caissier.id, pin: '4567', username: 'nadia', password: 'Nadia-Pass-2026' })
    expect(created.statusCode).toBe(200)
    expect((await h.api('GET', '/api/profiles')).statusCode).toBe(200)
    expect(body<{ value: unknown[] }>(await h.api('GET', '/api/profiles')).value.length).toBeGreaterThanOrEqual(3)
  })
})
