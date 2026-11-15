// `ATLAS_SMOKE=1`: the installed application proves, without a person, that it can start from nothing, finish its
// setup, sell, print and back up. It runs on a temporary data directory (never on a real installation), through the
// use cases (no window is driven), prints `SMOKE_OK <ticketLabel> <backupSha>` and the caller quits with code 0;
// any failure prints `SMOKE_FAIL <reason>` and the caller exits with 1. Used by `scripts/smoke-linux.sh`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runtime } from '../composition/runtime'
import type { SetupService } from '../application/usecases/setup'
import type { Result } from '@shared/result'
import type { DataPaths } from '../paths'

export const SMOKE_ENV = 'ATLAS_SMOKE'

const MANAGER_PIN = '2468'

let root: string | null = null

/** One temporary folder per run, removed again when the process ends. */
function smokeRoot(): string {
  if (root) return root
  root = mkdtempSync(join(tmpdir(), 'atlas-smoke-'))
  const folder = root
  process.on('exit', () => {
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {
      // A temporary folder: the system clears it.
    }
  })
  return root
}

/** The temporary data directory: a real installation is never touched. */
export const smokeDataDir = (): string => join(smokeRoot(), 'data')

/** Electron's own user-data folder, temporary too: the self-test never meets the single-instance lock of a till running on the machine. */
export const smokeUserDataDir = (): string => join(smokeRoot(), 'user-data')

/** The value of a successful result; throws the error code otherwise. */
function ok<T>(step: string, result: Result<T>): T {
  if (!result.ok) throw new Error(`${step}: ${result.error.code} ${JSON.stringify(result.error.params ?? {})}`)
  return result.value
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

export interface SmokeDeps {
  setup: SetupService
  runtime: Runtime
  paths: DataPaths
  /** A clean quit (the services stop, the database closes): the exit code is 0. */
  quit(): void
  /** Exits at once with code 1. */
  abort(): void
}

/** Setup (café template, one virtual printer), one cash sale closed, one full backup. Resolves with the `SMOKE_OK` line. */
async function runSmoke(deps: SmokeDeps): Promise<string> {
  const { setup, runtime, paths } = deps
  check(runtime.status().route === '#/setup' && runtime.services() === null, 'a new data directory must start on the setup')
  check(setup.templates().some((template) => template.id === 'cafe'), 'the café template is not bundled')

  const backupDisk = join(paths.root, '..', 'backup-disk')
  mkdirSync(backupDisk, { recursive: true })
  ok(
    'saveDraft',
    setup.saveDraft({
      step: 7,
      businessType: 'cafe',
      modules: { tables: false, kitchen: false, menus: false, customers: false, stock: false, barcode: false, scale: false },
      legal: {
        raisonSociale: 'Atlas Smoke SARL',
        nomCommercial: 'Atlas Smoke',
        adresse: '1 rue du Test',
        ville: 'Casablanca',
        telephone: '0522000000',
        ice: '001234567000012',
        if: '12345678',
        rc: '123456',
        patente: '31234567'
      },
      printers: [{ tempId: 'till', name: 'Caisse', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }],
      users: [{ displayName: 'Smoke', pin: MANAGER_PIN, profileCode: 'gerant', username: 'smoke', password: 'Smoke-Pass-2026' }],
      technicianCode: 'smoke-654321',
      backups: [{ role: 'disk', path: backupDisk, label: 'Disque de test' }],
      // Nothing that would touch the machine running the test.
      autostart: false,
      kiosk: false
    })
  )
  ok('finishSetup', await setup.finishSetup())
  // The template photos come from the packaged resources (extraResources).
  const photos = readdirSync(join(paths.media, 'products')).filter((file) => file.endsWith('.webp'))
  check(photos.length > 0, 'no template product photo was installed (extraResources missing from the package?)')

  runtime.reopen()
  const services = runtime.services()
  check(services !== null, 'the services did not open after the setup')
  if (!services) throw new Error('unreachable')

  const user = services.users.listTillUsers().find((u) => u.displayName === 'Smoke')
  check(user !== undefined, 'the setup user is missing')
  const session = ok('loginPin', await services.users.loginPin(user!.id, MANAGER_PIN))

  const catalog = services.catalog.listCatalog()
  const menuProducts = new Set(catalog.menus.map((menu) => menu.productId))
  const product = catalog.products.find((p) => p.active && !p.soldByWeight && p.modifierGroupIds.length === 0 && !menuProducts.has(p.id))
  check(product !== undefined, 'the café template has no simple product')

  const order = ok('openOrder', services.orders.openOrder(session, { type: 'counter' }))
  ok('addLine', services.orders.addLine(session, order.id, { productId: product!.id, qtyMilli: 1000 }))
  const due = ok('getOrder', services.orders.getOrder(session, order.id)).dueCents
  check(due > 0, 'the order has nothing to pay')
  ok('addPayment', services.orders.addPayment(session, order.id, { methodCode: 'cash', amountCents: due }))
  const ticket = ok('closeOrder', services.tickets.closeOrder(session, order.id))

  // The receipt goes to the virtual printer (the print queue started with the services): a file in prints/.
  const deadline = Date.now() + 15_000
  while (!readdirSync(paths.prints).some((file) => file.endsWith('.bin'))) {
    check(Date.now() < deadline, 'no receipt reached the virtual printer')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const backup = await services.backup.runFull('manual', 'smoke')
  if (!backup.ok) throw new Error(`backup: ${backup.error.code}`)
  check(backup.results.length > 0 && backup.results.every((r) => r.ok), `backup: a destination failed ${JSON.stringify(backup.results)}`)

  return `SMOKE_OK ${ticket.label} ${backup.sha256}`
}

/** Runs the smoke test, prints `SMOKE_OK ...` and quits, or prints `SMOKE_FAIL <reason>` (and the end of the log) and exits 1. */
export async function runSmokeAndExit(deps: SmokeDeps): Promise<void> {
  try {
    process.stdout.write(`${await runSmoke(deps)}\n`)
    deps.quit()
  } catch (error) {
    process.stdout.write(`SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}\n`)
    try {
      const lines = readFileSync(join(deps.paths.logs, 'app.log'), 'utf8').trimEnd().split('\n')
      process.stderr.write(`${lines.slice(-20).join('\n')}\n`)
    } catch {
      // No log to show.
    }
    deps.abort()
  }
}
