import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A 1x1 PNG: enough to prove the wizard keeps a logo and draws it in the receipt preview.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** Where `page.screenshot` files go (optional: `WIZARD_SHOTS=/some/dir`). */
const shots = process.env['WIZARD_SHOTS']
const shot = async (page: Page, name: string): Promise<void> => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  // Messages that linger from earlier steps would hide the screen.
  await page.locator('.toasts').evaluate((el) => ((el as HTMLElement).style.visibility = 'hidden'))
  await page.screenshot({ path: join(shots, `${name}.png`) })
  await page.locator('.toasts').evaluate((el) => ((el as HTMLElement).style.visibility = ''))
}

async function launch(dataDir: string, userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // The dev shell sets these; a launched Electron must behave as Electron and load the built renderer.
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']
  env['ATLAS_DATA_DIR'] = dataDir
  // Its own user data dir: another Atlas window may hold Electron's single-instance lock.
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env, cwd: process.cwd() })
  // Hidden printing helper windows may exist: take the till window.
  const deadline = Date.now() + 30_000
  for (;;) {
    const page = app.windows().find((window) => /index\.html#\//.test(window.url()))
    if (page) return { app, page }
    if (Date.now() > deadline) throw new Error(`no till window: ${app.windows().map((window) => window.url()).join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** The native dialogs cannot be driven: every "open" dialog answers with this path. */
const answerDialogsWith = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ dialog }, answer) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [answer] })) as typeof dialog.showOpenDialog
  }, path)

const next = (page: Page) => page.getByRole('button', { name: 'Suivant' }).click()

/** What the first test leaves for the next ones: a finished installation, its profile, its backup drive. */
const installed: { root: string; backupDir: string; profile: string } = { root: '', backupDir: '', profile: '' }

test.describe.configure({ mode: 'serial' })
test.afterAll(() => {
  if (installed.root) rmSync(installed.root, { recursive: true, force: true })
})

test('the technician wizard installs a restaurant till and lands on the login', async () => {
  test.setTimeout(180_000)
  const root = mkdtempSync(join(tmpdir(), 'atlas-e2e-'))
  installed.root = root
  const dataDir = join(root, 'data')
  const userData = join(root, 'user-data')
  const backupDir = join(root, 'backup-drive')
  const logoFile = join(root, 'logo.png')
  mkdirSync(backupDir)
  installed.backupDir = backupDir
  writeFileSync(logoFile, PNG)

  let { app, page } = await launch(dataDir, userData)
  try {
    // 0 - Start
    await expect(page.getByRole('heading', { name: 'Bienvenue dans Atlas POS' })).toBeVisible()
    await expect(page.getByTestId('start-profile')).toBeVisible()
    await expect(page.getByTestId('start-restore')).toBeVisible()
    await shot(page, '0-start')
    // Arabic turns the page right to left; back to French for the rest of the run
    await page.getByRole('tab', { name: 'العربية' }).click()
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await shot(page, '0-start-ar')
    await page.getByRole('tab', { name: 'Français' }).click()
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await page.getByTestId('start-new').click()

    // 1 - Langue
    await expect(page.getByRole('heading', { name: 'Langue', exact: true })).toBeVisible()
    await expect(page.getByText('Étape 1 sur 6')).toBeVisible()
    await shot(page, '1-langue')
    await next(page)

    // 2 - Type d'activité (resume: a reload comes back on the same step)
    await expect(page.getByRole('heading', { name: "Quel type d'activité ?" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: "Quel type d'activité ?" })).toBeVisible()
    await page.getByTestId('type-restaurant').click()
    await expect(page.getByRole('switch', { name: 'Plan de salle' })).toHaveAttribute('aria-checked', 'true')
    await shot(page, '2-type-activite')
    await next(page)

    // 3 - Entreprise: only the trade name is required (a café under a patente has no company identity); a malformed ICE is refused
    await expect(page.getByRole('heading', { name: "Informations de l'entreprise" })).toBeVisible()
    await next(page)
    await expect(page.locator('.wiz__alert')).toBeVisible()
    await expect(page.locator('.field--error')).toHaveCount(1)
    await page.getByLabel('ICE', { exact: true }).fill('12345')
    await next(page)
    await expect(page.locator('.field--error')).toHaveCount(2)
    await shot(page, '3-entreprise-errors')
    const fill = async (label: string, value: string) => page.getByLabel(label, { exact: true }).fill(value)
    await fill('Raison sociale', 'Café Atlas SARL')
    await fill('Nom commercial *', 'Café Atlas')
    await fill('Adresse', '24 boulevard Mohammed V')
    await fill('Ville', 'Casablanca')
    await fill('Téléphone', '05 22 45 67 89')
    await fill('ICE', '001234567000089')
    await fill('IF', '12345678')
    await fill('RC', '123456')
    await fill('Patente', '12345678')
    await answerDialogsWith(app, logoFile)
    await page.getByRole('button', { name: 'Ajouter un logo' }).click()
    await expect(page.getByText('Logo ajouté')).toBeVisible()
    await expect(page.locator('.wiz-receipt__logo')).toBeVisible()
    await expect.poll(() => page.locator('.wiz-receipt__logo').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await expect(page.locator('.wiz-receipt__paper')).toContainText('ICE : 001234567000089')
    await page.locator('.wiz__scroll').evaluate((el) => el.scrollTo({ top: 0 }))
    await shot(page, '3-entreprise')
    await next(page)

    // 4 - Matériel: a virtual printer, tested: a file lands in <data>/prints
    await expect(page.getByRole('heading', { name: 'Matériel' })).toBeVisible()
    await page.getByTestId('add-virtual').click()
    await expect(page.getByTestId('printer-row')).toHaveCount(1)
    await page.getByTestId('printer-test').click()
    await expect(page.getByText('Page de test envoyée.')).toBeVisible()
    await expect.poll(() => (existsSync(join(dataDir, 'prints')) ? readdirSync(join(dataDir, 'prints')).filter((name) => name.endsWith('.bin')).length : 0)).toBeGreaterThan(0)
    await page.getByTestId('printer-drawer').click()
    await shot(page, '4-materiel')
    await next(page)

    // 5 - Utilisateurs
    await expect(page.getByRole('heading', { name: 'Utilisateurs' })).toBeVisible()
    await fill('Nom affiché *', 'Karim')
    await fill('Code PIN *', '1234')
    await fill('Identifiant *', 'karim')
    await fill('Mot de passe *', 'motdepasse-1')
    await page.getByTestId('add-staff').click()
    const staff = page.locator('.wiz-staff__row')
    await staff.getByLabel('Nom affiché').fill('Salma')
    await staff.getByLabel('Code PIN').fill('5678')
    await fill('Code technicien *', '246810')
    await fill('Confirmer le code technicien *', '246811')
    await next(page)
    await expect(page.getByText('Les deux codes technicien ne sont pas identiques.').first()).toBeVisible()
    await fill('Confirmer le code technicien *', '246810')
    await shot(page, '5-utilisateurs')
    await next(page)

    // 6 - Sauvegardes: a drive in a temp folder, tested OK
    await expect(page.getByRole('heading', { name: 'Sauvegardes' })).toBeVisible()
    await answerDialogsWith(app, backupDir)
    const disk = page.getByTestId('backup-disk')
    await disk.getByRole('switch').click()
    await page.getByTestId('backup-browse-disk').click()
    await expect(disk.getByLabel('Dossier')).toHaveValue(backupDir)
    await page.getByTestId('backup-test-disk').click()
    await expect(disk.getByText(/^Testé/)).toBeVisible()
    await shot(page, '6-sauvegardes')
    await page.getByRole('button', { name: "Terminer l'installation" }).click()

    // Finish: the till is ready, "Commencer" opens the PIN login
    await expect(page.getByRole('heading', { name: 'Installation terminée' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('finish-error')).toHaveCount(0)
    await shot(page, '7-fin')
    // The technician exports this setup as a profile (used by the next test)
    const exported = await page.evaluate(async (code) => {
      const signed = await window.atlas.invoke('users.verifyTechnician', { code })
      if (!signed.ok) throw new Error(signed.error.code)
      const file = await window.atlas.invoke('tech.exportProfile', {})
      if (!file.ok) throw new Error(file.error.code)
      return Array.from(file.value.bytes)
    }, '246810')
    installed.profile = join(root, 'setup.atlasprofile')
    writeFileSync(installed.profile, Buffer.from(exported))
    await page.getByTestId('finish-start').click()
    await page.waitForURL(/#\/login/, { timeout: 30_000 })
    await shot(page, '8-login')

    // The installation is permanent: a relaunch opens the login, not the setup
    await app.close()
    ;({ app, page } = await launch(dataDir, userData))
    await page.waitForURL(/#\/login/, { timeout: 30_000 })
    expect(page.url()).not.toContain('#/setup')
  } finally {
    // the folder stays: the next tests use its profile and its backup drive (removed in afterAll)
    await app.close().catch(() => undefined)
  }
})

test('a setup profile pre-fills the wizard, and its company details must be confirmed', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'atlas-e2e-profile-'))
  const { app, page } = await launch(join(root, 'data'), join(root, 'user-data'))
  try {
    await expect(page.getByRole('heading', { name: 'Bienvenue dans Atlas POS' })).toBeVisible()
    await answerDialogsWith(app, installed.profile)
    await page.getByTestId('start-profile').click()
    await expect(page.getByRole('heading', { name: 'Langue', exact: true })).toBeVisible()
    await next(page)
    // the catalogue of the profile is the chosen source
    await expect(page.getByTestId('source-profile')).toHaveAttribute('aria-pressed', 'true')
    await next(page)
    await expect(page.getByText(/Ces informations viennent du profil importé/)).toBeVisible()
    await expect(page.getByLabel('Nom commercial *', { exact: true })).toHaveValue('Café Atlas')
    await shot(page, '9-profil-entreprise')
    await next(page)
    await expect(page.getByRole('heading', { name: 'Matériel' })).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a backup restores a new computer and lands on the login', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'atlas-e2e-restore-'))
  const { app, page } = await launch(join(root, 'data'), join(root, 'user-data'))
  try {
    await expect(page.getByRole('heading', { name: 'Bienvenue dans Atlas POS' })).toBeVisible()
    await answerDialogsWith(app, installed.backupDir)
    await page.getByTestId('start-restore').click()
    await expect(page.getByRole('dialog', { name: 'Choisir une sauvegarde' })).toBeVisible()
    await shot(page, '10-restauration')
    await page.locator('.wiz-list__row').first().click()
    await page.getByRole('dialog', { name: 'Restaurer cette sauvegarde ?' }).getByRole('button', { name: 'Restaurer' }).click()
    await page.waitForURL(/#\/login/, { timeout: 60_000 })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

