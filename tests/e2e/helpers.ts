import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { paperText } from '../helpers/escpos-decode'

/** Where the screenshots go: `ATLAS_E2E_SHOTS`, else a temporary folder. */
export const SHOTS = process.env['ATLAS_E2E_SHOTS'] ?? join(tmpdir(), 'atlas-till-shots')

export const PINS = { Karim: '1234', Sara: '2222', Youssef: '3333' } as const
export const TECH_CODE = '654321'

export type Business = 'restaurant' | 'cafe' | 'bakery' | 'retail'

const MODULES: Record<Business, Record<string, boolean>> = {
  restaurant: { tables: true, kitchen: true, menus: true, customers: true, stock: false, barcode: false, scale: false },
  cafe: { tables: true, kitchen: true, menus: true, customers: false, stock: false, barcode: false, scale: false },
  bakery: { tables: false, kitchen: false, menus: false, customers: false, stock: false, barcode: false, scale: false },
  retail: { tables: false, kitchen: false, menus: false, customers: false, stock: true, barcode: true, scale: false }
}

type Bridge = { atlas: { invoke(channel: string, input: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }> } }

export interface Till {
  app: ElectronApplication
  page: Page
  dataDir: string
  printsDir: string
  close(): Promise<void>
  /** Stops the process without a clean shutdown (a power cut). */
  kill(): Promise<void>
  /** Starts the application again on the same data (after `close` or `kill`). */
  relaunch(): Promise<void>
  cleanup(): void
}

/** The application on a data directory, with its own Electron user-data dir (the owner's window may hold the single-instance lock). */
async function launch(dataDir: string, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  env['ATLAS_DATA_DIR'] = dataDir
  const app = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userData}`], env, cwd: resolve('.') })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * A finished installation of a business type (virtual printers Caisse / Cuisine / Bar, users Karim the manager,
 * Sara the cashier and Youssef the waiter), made through the setup channels, then the application started on it.
 */
export async function startTill(business: Business): Promise<Till> {
  const root = mkdtempSync(join(tmpdir(), 'atlas-e2e-'))
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backup-disk')
  const userData = join(root, 'user-data')
  mkdirSync(backupDir)

  const first = await launch(dataDir, userData)
  await first.page.waitForFunction(() => 'atlas' in window)
  const patch = {
    step: 7,
    businessType: business,
    modules: MODULES[business],
    legal: { raisonSociale: 'Atlas Test SARL', nomCommercial: 'Atlas Test', adresse: '12 avenue Hassan II', ville: 'Casablanca', telephone: '0522000000', ice: '001234567000012', if: '12345678', rc: '123456', patente: '31234567' },
    printers: [
      { tempId: 'till', name: 'Caisse', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true },
      { tempId: 'kitchen', name: 'Cuisine', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'kitchen', active: true },
      { tempId: 'bar', name: 'Bar', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'bar', active: true }
    ],
    users: [
      { displayName: 'Karim', pin: PINS.Karim, profileCode: 'gerant', username: 'karim', password: 'Atlas-Secret-2026' },
      { displayName: 'Sara', pin: PINS.Sara, profileCode: 'caissier' },
      { displayName: 'Youssef', pin: PINS.Youssef, profileCode: 'serveur' }
    ],
    technicianCode: TECH_CODE,
    backups: [{ role: 'disk', path: backupDir, label: 'Disque 2' }]
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

  // A normal start on the finished installation: the print queue and the backup engine run.
  const second = await launch(dataDir, userData)
  const till: Till = {
    app: second.app,
    page: second.page,
    dataDir,
    printsDir: join(dataDir, 'prints'),
    close: () => till.app.close(),
    kill: async () => {
      const exited = new Promise<void>((resolveExit) => till.app.process().once('exit', () => resolveExit()))
      till.app.process().kill('SIGKILL')
      await exited
    },
    relaunch: async () => {
      const next = await launch(dataDir, userData)
      till.app = next.app
      till.page = next.page
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
  await toLogin(till.page)
  return till
}

/** The login screen (after a recovery screen, if the previous run did not stop cleanly). */
export async function toLogin(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="login-users"], [data-testid="recovery"]', { timeout: 30_000 })
  if (await page.getByTestId('recovery').count()) await page.getByTestId('recovery-continue').click()
  await expect(page.getByTestId('login-users')).toBeVisible()
}

/** Signs in with the PIN of a user tile (the keypad reads the physical keyboard as well). */
export async function login(page: Page, user: keyof typeof PINS): Promise<void> {
  await toLogin(page)
  await page.getByTestId(`user-${user}`).click()
  await page.keyboard.type(PINS[user])
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('user-menu')).toHaveCount(0)
  await page.waitForFunction(() => !window.location.hash.startsWith('#/login'), undefined, { timeout: 15_000 })
}

export async function logout(page: Page): Promise<void> {
  await page.locator('.topbar__user').click()
  await page.getByTestId('switch-user').click()
  await expect(page.getByTestId('login-users')).toBeVisible()
}

/** The paper of every job a printer got, text of each, oldest first. */
export function printed(printsDir: string, slug: string): string[] {
  try {
    return readdirSync(printsDir)
      .filter((file) => file.endsWith(`-${slug}.bin`))
      .sort()
      .map((file) => paperText(readFileSync(join(printsDir, file))))
  } catch {
    return []
  }
}

/** Waits until a printer has a job whose paper matches, and returns that paper. */
export async function waitForPrint(printsDir: string, slug: string, match: RegExp | string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = printed(printsDir, slug).find((paper) => (typeof match === 'string' ? paper.includes(match) : match.test(paper)))
    if (found) return found
    if (Date.now() > deadline) throw new Error(`no ${slug} print matching ${String(match)}; got:\n${printed(printsDir, slug).join('\n----\n')}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/** Adds a product by its name (the key's accessible name), after an optional quantity typed on the quantity keys. */
export async function addProduct(page: Page, name: string, qty?: number): Promise<void> {
  if (qty) for (const digit of String(qty)) await page.getByTestId(`qty-${digit}`).click()
  await page.getByRole('button', { name, exact: true }).click()
}

export async function openCategory(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
}
