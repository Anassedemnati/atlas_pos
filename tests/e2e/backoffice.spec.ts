import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, chromium, expect, test, type Browser, type ElectronApplication, type Page } from '@playwright/test'

/** The LAN back office, in a real browser, against the application started on a finished installation. */

const SHOTS = process.env['ATLAS_E2E_SHOTS'] ?? join(tmpdir(), 'atlas-backoffice-shots')
const PASSWORD = 'Atlas-Secret-2026'
const PIN = '1234'

type Bridge = { atlas: { invoke(channel: string, input: unknown): Promise<{ ok: boolean; error?: unknown }> } }

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })

async function launch(dataDir: string, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  env['ATLAS_DATA_DIR'] = dataDir
  const app = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userData}`], env, cwd: resolve('.') })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** A finished bakery installation (Karim the manager with a back office login, Youssef the waiter with none), the back office on `port`. */
async function install(root: string, port: number): Promise<string> {
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backup-disk')
  mkdirSync(backupDir)
  const first = await launch(dataDir, join(root, 'user-data'))
  await first.page.waitForFunction(() => 'atlas' in window)
  const patch = {
    step: 7,
    businessType: 'bakery',
    modules: { tables: false, kitchen: false, menus: false, customers: false, stock: false, barcode: false, scale: false },
    legal: { raisonSociale: 'Atlas Test SARL', nomCommercial: 'Atlas Test', adresse: '12 avenue Hassan II', ville: 'Casablanca', telephone: '0522000000', ice: '001234567000012', if: '12345678', rc: '123456', patente: '31234567' },
    printers: [{ tempId: 'till', name: 'Caisse', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }],
    users: [
      { displayName: 'Karim', pin: PIN, profileCode: 'gerant', username: 'karim', password: PASSWORD },
      { displayName: 'Youssef', pin: '3333', profileCode: 'serveur', username: 'youssef', password: 'Serveur-Pass-2026' }
    ],
    technicianCode: '654321',
    backups: [{ role: 'disk', path: backupDir, label: 'Disque 2' }],
    backofficePort: port
  }
  const done = await first.page.evaluate(async (draft) => {
    const bridge = (window as unknown as Bridge).atlas
    const saved = await bridge.invoke('setup.saveDraft', { patch: draft })
    if (!saved.ok) return { ok: false, step: 'saveDraft', error: saved.error }
    const finished = await bridge.invoke('setup.finish', {})
    return { ok: finished.ok, step: 'finish', error: finished.error }
  }, patch)
  if (!done.ok) throw new Error(`setup failed at ${done.step}: ${JSON.stringify(done.error)}`)
  await first.app.close()
  return dataDir
}

/** Playwright's own Chromium (`npx playwright install chromium`), or the Chrome installed on the machine. */
async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch()
  } catch {
    return chromium.launch({ channel: 'chrome' })
  }
}

const csv = (rows: string[][]): Buffer => Buffer.from(['categorie;name_fr;name_ar;name_en;prix;tva;code_barres;au_poids;stock;couleur', ...rows.map((r) => r.join(';'))].join('\r\n') + '\r\n')

test.describe.serial('LAN back office', () => {
  let root: string
  let app: ElectronApplication
  let till: Page
  let browser: Browser
  let page: Page
  let base: string

  test.beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-bo-'))
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    const dataDir = await install(root, port)
    const second = await launch(dataDir, join(root, 'user-data'))
    app = second.app
    till = second.page
    // The till: signed in as Karim, on the "Pâtisserie marocaine" tab of the order pad.
    await till.waitForSelector('[data-testid="login-users"], [data-testid="recovery"]', { timeout: 30_000 })
    if (await till.getByTestId('recovery').count()) await till.getByTestId('recovery-continue').click()
    await till.getByTestId('user-Karim').click()
    await till.keyboard.type(PIN)
    await till.keyboard.press('Enter')
    await till.getByRole('tab', { name: 'Pâtisserie marocaine', exact: true }).click()
    await expect(till.getByRole('button', { name: 'Chebakia', exact: true })).toBeVisible()
    browser = await launchBrowser()
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' })).newPage()
  })

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const shot = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `bo-${name}.png`) })
  }

  test('the page is served, signs in only a manager, and a wrong password is refused', async () => {
    const response = await page.goto(`${base}/admin`)
    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
    await expect(page.getByTestId('login-form')).toBeVisible()
    await shot('01-login')
    await page.getByTestId('login-username').fill('karim')
    await page.getByTestId('login-password').fill('not-the-password')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toBeVisible()
    // Youssef is a waiter: right password, no back office permission.
    await page.getByTestId('login-username').fill('youssef')
    await page.getByTestId('login-password').fill('Serveur-Pass-2026')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toBeVisible()
    await page.getByTestId('login-username').fill('karim')
    await page.getByTestId('login-password').fill(PASSWORD)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('signed-in-as')).toContainText('Karim')
    // The session cookie is HttpOnly: the page cannot read it.
    expect(await page.evaluate(() => document.cookie)).not.toContain('atlas_sid')
    await expect(page.getByTestId('dash-sales')).toBeVisible()
    await shot('02-dashboard')
    // A reload keeps the session (and its CSRF token, asked again from the server).
    await page.reload()
    await expect(page.getByTestId('signed-in-as')).toContainText('Karim')
  })

  test('creating the product Pastilla at 85,00 DH shows its key on the till at once', async () => {
    await page.getByTestId('nav-products').click()
    await expect(page.getByTestId('products-table')).toBeVisible()
    await shot('03-products')
    await page.getByTestId('product-new').click()
    const drawer = page.getByTestId('product-drawer')
    await expect(drawer).toBeVisible()
    await drawer.getByTestId('name-fr').fill('Pastilla')
    await drawer.getByTestId('name-ar').fill('بسطيلة')
    await drawer.getByTestId('product-price').fill('85,00')
    await drawer.getByRole('button', { name: /^Catégorie/ }).click()
    await page.getByRole('option', { name: 'Pâtisserie marocaine' }).click()
    await shot('04-product-drawer')
    await drawer.getByTestId('product-save').click()
    const row = page.getByTestId('product-row-Pastilla')
    await expect(row).toBeVisible()
    await expect(row).toContainText('85,00 DH')
    await expect(row).toContainText('Pâtisserie marocaine')
    // The till (the Electron window) heard catalog.changed: the key is there without any reload.
    await expect(till.getByRole('button', { name: 'Pastilla', exact: true })).toBeVisible({ timeout: 10_000 })
    // And it sells at that price.
    await till.getByRole('button', { name: 'Pastilla', exact: true }).click()
    await expect(till.getByTestId('ticket-total')).toHaveText('85,00 DH')
  })

  test('a product can be edited, searched and switched off from the table', async () => {
    await page.getByTestId('product-search').fill('pastilla')
    await expect(page.getByTestId('product-row-Pastilla')).toBeVisible()
    await page.getByTestId('product-row-Pastilla').getByRole('switch').click()
    await expect.poll(async () => (await (await page.request.get(`${base}/api/catalog`)).json()).value.products.find((p: { name: { fr: string } }) => p.name.fr === 'Pastilla').active).toBe(false)
    await page.getByTestId('product-search').fill('')
  })

  test('an import with one bad row shows the error and adds nothing; a clean one is applied', async () => {
    const count = async (): Promise<number> => (await (await page.request.get(`${base}/api/catalog`)).json()).value.products.length
    const before = await count()
    await page.getByTestId('import-open').click()
    await page.getByTestId('import-file').setInputFiles({
      name: 'produits.csv',
      mimeType: 'text/csv',
      buffer: csv([
        ['Pâtisserie marocaine', 'Gazelle', '', '', '12', '10', '', 'non', '', ''],
        ['Pâtisserie marocaine', 'Briouate', '', '', 'abc', '10', '', 'non', '', '']
      ])
    })
    await expect(page.getByTestId('import-summary')).toContainText('1 erreur')
    await expect(page.getByTestId('import-errors')).toContainText('prix')
    await expect(page.getByTestId('import-apply')).toBeDisabled()
    await shot('05-import-errors')
    expect(await count()).toBe(before)
    // Fixing the file: the preview is clean, the import applies.
    await page.getByTestId('import-file').setInputFiles({
      name: 'produits.csv',
      mimeType: 'text/csv',
      buffer: csv([
        ['Pâtisserie marocaine', 'Gazelle', '', '', '12', '10', '', 'non', '', ''],
        ['Pâtisserie marocaine', 'Briouate', '', '', '9,50', '10', '', 'non', '', '']
      ])
    })
    await expect(page.getByTestId('import-summary')).toContainText('2 lignes prêtes')
    await expect(page.getByTestId('import-apply')).toBeEnabled()
    await page.getByTestId('import-apply').click()
    await expect(page.getByTestId('product-row-Briouate')).toBeVisible()
    expect(await count()).toBe(before + 2)
  })

  test('categories, keyboards, users, printers, reports, settings and the journal open', async () => {
    for (const section of ['categories', 'menus', 'keyboards', 'users', 'printers', 'reports', 'settings', 'journal'] as const) {
      await page.getByTestId(`nav-${section}`).click()
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await page.waitForLoadState('networkidle')
      await shot(`10-${section}`)
    }
    // Reports: the table has the columns of the grouping and the export links carry the period.
    await page.getByTestId('nav-reports').click()
    await expect(page.getByTestId('report-table')).toBeVisible()
    await expect(page.getByTestId('report-xlsx')).toHaveAttribute('href', /\/api\/reports\/export\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&group=day&format=xlsx/)
    // Settings: the receipt footer is saved and the preview follows what is typed.
    await page.getByTestId('nav-settings').click()
    await page.getByRole('tab', { name: 'Ticket de caisse' }).click()
    await page.getByTestId('receipt-footer').fill('À très bientôt !')
    await expect(page.getByTestId('receipt-preview')).toContainText('À très bientôt !')
    await page.getByTestId('settings-save-receipt').click()
    await expect.poll(async () => (await (await page.request.get(`${base}/api/settings`)).json()).value.values['receipt.footer']).toBe('À très bientôt !')
  })

  test('keyboards: moving a category up changes the order the till shows', async () => {
    const order = async (): Promise<string[]> => (await (await page.request.get(`${base}/api/catalog`)).json()).value.categories.map((c: { name: { fr: string } }) => c.name.fr)
    const before = await order()
    await page.getByTestId('nav-keyboards').click()
    const second = (await (await page.request.get(`${base}/api/catalog`)).json()).value.categories[1].id
    await page.getByTestId(`up-${second}`).click()
    await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)])
    // The till tabs follow.
    await expect(till.getByRole('tab').first()).toHaveText(before[1]!)
  })

  test('backups: "Sauvegarder maintenant" adds a new entry; restoring needs the typed word', async () => {
    await page.getByTestId('nav-backups').click()
    await expect(page.getByTestId('backups-table')).toBeVisible()
    const entries = page.getByTestId('backup-entry')
    await expect(entries.first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined)
    const before = await entries.count()
    await page.getByTestId('backup-run').click()
    await expect.poll(() => entries.count(), { timeout: 30_000 }).toBeGreaterThan(before)
    await shot('20-backups')
    await entries.first().getByTestId('backup-restore').click()
    await expect(page.getByTestId('confirm-typed-go')).toBeDisabled()
    await page.getByTestId('confirm-typed-input').fill('restaurer')
    await expect(page.getByTestId('confirm-typed-go')).toBeDisabled()
    await page.getByTestId('confirm-typed-input').fill('RESTAURER')
    await expect(page.getByTestId('confirm-typed-go')).toBeEnabled()
    await shot('21-restore-confirm')
    // Not confirmed: leave it (a restore would end the session and reload the till).
    await page.keyboard.press('Escape')
  })

  test('the interface switches to Arabic (right to left) and signing out closes the session', async () => {
    await page.getByTestId('lang-ar').click()
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await shot('30-arabic')
    await page.getByTestId('lang-fr').click()
    await page.getByTestId('sign-out').click()
    await expect(page.getByTestId('login-form')).toBeVisible()
    expect((await page.request.get(`${base}/api/catalog`)).status()).toBe(401)
  })
})
