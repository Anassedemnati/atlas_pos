import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../../../src/main/application/events'
import { createRuntime, type Runtime } from '../../../src/main/composition/runtime'
import { openDatabase } from '../../../src/main/infrastructure/db/connection'
import { readInstallation } from '../../../src/main/infrastructure/fs/installation'
import type { IpcDeps, ShellPorts } from '../../../src/main/interfaces/ipc/context'
import { dispatch } from '../../../src/main/interfaces/ipc/register'
import { createSessionStore } from '../../../src/main/interfaces/ipc/session-store'
import { ensureDataLayout, type DataPaths } from '../../../src/main/paths'
import type { Channel } from '../../../src/shared/ipc-contract'
import { completeDraft, log, MANAGER_PIN, TECH_CODE, testSetupService, type SetupEnv } from '../../helpers/setup'
import { csvBuffer, SAMPLE } from '../../helpers/sheets'

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh installation directory with the whole application graph on it: runtime, setup service, IPC. */
function app() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-ipc-'))
  dirs.push(root)
  const paths: DataPaths = ensureDataLayout(join(root, 'data'))
  const backupDir = join(root, 'disk2')
  ensureDirs(backupDir)
  const logger = log()
  const runtime = createRuntime({
    paths,
    clock: { now: () => new Date() },
    bus: createEventBus(),
    log: logger,
    appVersion: '0.1.0',
    rasterize: async () => {
      throw new Error('no rendering in tests')
    },
    unclean: false,
    safeMode: false
  })
  runtimes.push(runtime)
  runtime.boot()
  const setup = testSetupService({ paths, log: logger, restore: (file) => runtime.restore(file) })
  const shell = {
    appVersion: '0.1.0',
    navigateTill: vi.fn(),
    restartNormally: vi.fn(),
    afterSetup: vi.fn(),
    quitToDesktop: vi.fn(),
    detectHardware: vi.fn(async () => ({ osPrinters: [], serialPorts: [], deviceFiles: [], displays: [] }))
  }
  const deps: IpcDeps = { paths, runtime, setup, shell: shell as unknown as ShellPorts, log: logger }
  const sessions = createSessionStore()
  const call = async (channel: Channel, input: unknown = {}, windowId = 1) => dispatch(channel, windowId, input, deps, sessions)
  const env = { paths, backupDir, root, cleanup() {} } satisfies SetupEnv
  return { paths, backupDir, runtime, shell, sessions, call, env, root }
}

const ensureDirs = (dir: string): void => void mkdirSync(dir, { recursive: true })

/** Saves a complete draft through the IPC and finishes. */
async function install(a: ReturnType<typeof app>, patch = {}) {
  const saved = await a.call('setup.saveDraft', { patch: completeDraft(a.env, patch) })
  expect(saved).toMatchObject({ ok: true })
  return a.call('setup.finish')
}

describe('the setup channels', () => {
  it('walks a new installation to #/login without a restart', async () => {
    const a = app()
    expect(a.runtime.status()).toMatchObject({ route: '#/setup', ready: false, report: { state: 'needs-setup' } })
    expect(await a.call('users.listTill')).toMatchObject({ ok: false, error: { code: 'app_not_ready' } })

    const templates = await a.call('setup.templates')
    expect(templates).toMatchObject({ ok: true })
    expect(await a.call('setup.detectHardware')).toMatchObject({ ok: true, value: { osPrinters: [] } })
    // Nothing to finish yet.
    expect(await a.call('setup.finish')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(a.runtime.status().ready).toBe(false)

    const done = await install(a)
    expect(done).toMatchObject({ ok: true, value: { route: '#/login', warnings: [] } })
    expect(a.runtime.status()).toMatchObject({ ready: true, route: '#/login', report: { state: 'ok' } })
    expect(a.shell.afterSetup).toHaveBeenCalledOnce()
    expect(existsSync(join(a.paths.config, 'wizard-draft.json'))).toBe(false)

    // The till works on the new database: Karim is on the PIN screen and signs in.
    const tillUsers = await a.call('users.listTill')
    expect(tillUsers).toMatchObject({ ok: true, value: [{ displayName: 'Karim' }] })
    const userId = (tillUsers as { value: { id: string }[] }).value[0]!.id
    expect(await a.call('users.loginPin', { userId, pin: MANAGER_PIN })).toMatchObject({ ok: true })
    expect(await a.call('catalog.list')).toMatchObject({ ok: true })

    // Setup is over: every setup channel is closed, and the till window can be reloaded on the login.
    for (const channel of ['setup.templates', 'setup.getDraft', 'setup.finish', 'setup.detectHardware'] as const) {
      expect(await a.call(channel)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'setup_complete' } } })
    }
    // A signed-in window cannot be reloaded this way; the one that has just set up (nobody signed in) can.
    expect(await a.call('setup.openTill')).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'signed_in' } } })
    expect(await a.call('setup.openTill', {}, 2)).toEqual({ ok: true, value: true })
    expect(a.shell.navigateTill).toHaveBeenCalledWith('#/login')
  })

  it('is closed on a corrupt installation, which must be restored, never set up over', async () => {
    const a = app()
    await install(a)
    await a.runtime.shutdown()
    writeFileSync(a.paths.dbFile, 'garbage '.repeat(1000))
    const second = createRuntime({
      paths: a.paths,
      clock: { now: () => new Date() },
      bus: createEventBus(),
      log: log(),
      appVersion: '0.1.0',
      rasterize: async () => {
        throw new Error('x')
      },
      unclean: false,
      safeMode: false
    })
    runtimes.push(second)
    second.boot()
    expect(second.status().report?.state).toBe('corrupt')
    const deps: IpcDeps = { paths: a.paths, runtime: second, setup: testSetupService({ paths: a.paths }), shell: a.shell as unknown as ShellPorts, log: log() }
    expect(await dispatch('setup.finish', 1, {}, deps, createSessionStore())).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await dispatch('setup.templates', 1, {}, deps, createSessionStore())).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('reads files by path and refuses a bad input shape', async () => {
    const a = app()
    const sheet = join(a.root, 'produits.csv')
    writeFileSync(sheet, csvBuffer(SAMPLE))
    expect(await a.call('setup.previewImport', { path: sheet })).toMatchObject({ ok: true, value: { rows: [{}, {}, {}], errors: [] } })
    expect(await a.call('setup.previewImport', { path: sheet, bytes: new Uint8Array(1) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await a.call('setup.previewImport', { path: join(a.root, 'nothing.csv') })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'path' } } })
    expect(await a.call('setup.previewImport', { bytes: new Uint8Array(csvBuffer(SAMPLE)), fileName: 'p.csv' })).toMatchObject({ ok: true })
    expect(await a.call('setup.saveDraft', { patch: { step: 99 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await a.call('setup.saveDraft', { patch: { nope: 1 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })
})

describe('restore mode', () => {
  it('restores a backup onto a new installation: the installation is rebuilt and the services open', async () => {
    const source = app()
    expect(await install(source)).toMatchObject({ ok: true })
    const sourceId = readInstallation(source.paths)!.installationId

    const fresh = app()
    expect(fresh.runtime.status().report?.state).toBe('needs-setup')
    // A folder must have been chosen with the dialog on this window.
    expect(await fresh.call('setup.listBackupsAt', { folder: source.backupDir })).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'folder_not_picked' } } })
    fresh.sessions.grantFolder(1, source.backupDir)
    const listed = await fresh.call('setup.listBackupsAt', { folder: source.backupDir })
    expect(listed).toMatchObject({ ok: true })
    const entries = (listed as { value: { file: string; kind: string }[] }).value
    const full = entries.find((e) => e.kind === 'full')
    expect(full).toBeDefined()

    // Only a file of that listing.
    expect(await fresh.call('setup.restoreFrom', { file: join(source.root, 'other.atlasbak'), folder: source.backupDir })).toMatchObject({ ok: false, error: { code: 'backup_not_found' } })
    expect(readInstallation(fresh.paths)).toBeNull()

    expect(await fresh.call('setup.restoreFrom', { file: full!.file, folder: source.backupDir })).toEqual({ ok: true, value: { route: '#/login' } })
    expect(fresh.runtime.status()).toMatchObject({ ready: true, route: '#/login' })
    expect(readInstallation(fresh.paths)).toMatchObject({ installationId: sourceId })
    expect(readInstallation(fresh.paths)?.setupCompletedAt).toBeTruthy()
    expect(fresh.shell.afterSetup).toHaveBeenCalledOnce()
    expect(await fresh.call('users.listTill')).toMatchObject({ ok: true, value: [{ displayName: 'Karim' }] })
    expect(await fresh.call('setup.templates')).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('leaves a new installation alone when the restore fails', async () => {
    const fresh = app()
    const bad = join(fresh.root, 'bad')
    ensureDirs(bad)
    fresh.sessions.grantFolder(1, bad)
    expect(await fresh.call('setup.restoreFrom', { file: join(bad, 'x.atlasbak'), folder: bad })).toMatchObject({ ok: false, error: { code: 'backup_not_found' } })
    expect(readInstallation(fresh.paths)).toBeNull()
    expect(fresh.runtime.status().report?.state).toBe('needs-setup')
  })
})

describe('the technician menu', () => {
  async function technician() {
    const a = app()
    expect(await install(a)).toMatchObject({ ok: true })
    return a
  }

  it('needs the technician mode of the window', async () => {
    const a = await technician()
    for (const channel of ['tech.exportProfile', 'tech.logs', 'tech.quitToDesktop'] as const) {
      expect(await a.call(channel)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'technician' } } })
    }
    expect(await a.call('tech.applyChanges', { patch: {} })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await a.call('users.verifyTechnician', { code: 'wrong-code' })).toMatchObject({ ok: false })
    expect(await a.call('users.verifyTechnician', { code: TECH_CODE })).toEqual({ ok: true, value: true })
    expect(await a.call('tech.exportProfile')).toMatchObject({ ok: true })
    // Another window is not in technician mode.
    expect(await a.call('tech.exportProfile', {}, 2)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('lists what the setup created', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    const floor = await a.call('floor.list')
    expect(floor).toMatchObject({ ok: true, value: { rooms: [{}, {}] } })
    expect((floor as { value: { tables: unknown[] } }).value.tables).toHaveLength(20)
    expect(await a.call('payments.list')).toMatchObject({ ok: true, value: [{ code: 'cash', opensDrawer: true }, { code: 'card' }, { code: 'cheque', active: false }] })
    const routing = await a.call('printing.routing')
    expect((routing as { value: { printerIds: string[] }[] }).value).toHaveLength(8)
    expect((routing as { value: { printerIds: string[] }[] }).value.every((r) => r.printerIds.length === 1)).toBe(true)
    const staff = await a.call('users.list')
    expect(staff).toMatchObject({ ok: true, value: { users: [{ displayName: 'Karim', username: 'karim', active: true }] } })
    const json = JSON.stringify(staff)
    expect(json).not.toContain('scrypt')
    expect(json).not.toContain('hash')
    expect((staff as { value: { profiles: unknown[] } }).value.profiles).toHaveLength(3)
    // Without the technician mode or a manager, the staff list is closed.
    expect(await a.call('users.list', {}, 2)).toMatchObject({ ok: false })
  })

  it('applies changes after a pre-change backup', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    const printers = (await a.call('printing.printers')) as { value: { id: string; name: string; role: string }[] }
    const bar = printers.value.find((p) => p.name === 'Bar')!

    const result = await a.call('tech.applyChanges', {
      patch: {
        receiptFooter: 'À bientôt',
        kiosk: false,
        backupSchedule: { continuous: true, onClose: false, retentionDays: 14 },
        printers: [
          // existing printers keep their id, a new tempId adds one, a printer left out is removed
          { tempId: bar.id, name: 'Bar terrasse', kind: 'virtual', address: '', widthMm: 58, lang: 'fr', raster: false, role: 'bar', active: true },
          { tempId: 'new', name: 'Pizza', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'kitchen', active: true }
        ],
        routing: {}
      }
    })
    expect(result).toEqual({ ok: true, value: { applied: expect.arrayContaining(['settings', 'printers']) } })

    const db = openDatabase(a.paths.dbFile)
    try {
      expect(db.prepare("SELECT COUNT(*) FROM backup_runs WHERE kind = 'pre-change'").pluck().get()).toBe(1)
      expect(JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = 'receipt.footer'").pluck().get() as string)).toBe('À bientôt')
      expect(JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = 'backup.retentionDays'").pluck().get() as string)).toBe(14)
      const rows = db.prepare('SELECT id, name, width_mm FROM printers ORDER BY name').all() as { id: string; name: string; width_mm: number }[]
      expect(rows.map((r) => r.name)).toEqual(['Bar terrasse', 'Pizza'])
      expect(rows.find((r) => r.name === 'Bar terrasse')).toMatchObject({ id: bar.id, width_mm: 58 })
      // The routing was cleared, as asked.
      expect(db.prepare('SELECT COUNT(*) FROM category_printers').pluck().get()).toBe(0)
    } finally {
      db.close()
    }
    // The pre-change copy is on the destination too.
    const dir = join(a.backupDir, 'AtlasBackup', 'full')
    expect(readdirSync(dir).some((n) => n.includes('pre-change') && n.endsWith('.atlasbak'))).toBe(true)
  })

  it('applies nothing when a rule fails, and takes no backup', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    expect(await a.call('tech.applyChanges', { patch: { legal: { raisonSociale: 'X', nomCommercial: 'X', adresse: 'a', ville: 'v', telephone: 't', ice: '1', if: '1', rc: '1', patente: '1' } } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(await a.call('tech.applyChanges', { patch: { technicianCode: '123' } })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'technicianCode' } } })
    expect(await a.call('tech.applyChanges', { patch: { printers: [{ tempId: 'x', name: 'N', kind: 'network', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }] } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'printers.0.address' } }
    })
    const db = openDatabase(a.paths.dbFile)
    expect(db.prepare("SELECT COUNT(*) FROM backup_runs WHERE kind = 'pre-change'").pluck().get()).toBe(0)
    db.close()
  })

  it('changes the technician code, and the old one stops working', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    expect(await a.call('tech.applyChanges', { patch: { technicianCode: 'nouveau-code-2026' } })).toMatchObject({ ok: true, value: { applied: ['technicianCode'] } })
    expect(await a.call('users.verifyTechnician', { code: TECH_CODE }, 3)).toMatchObject({ ok: false })
    expect(await a.call('users.verifyTechnician', { code: 'nouveau-code-2026' }, 3)).toMatchObject({ ok: true })
  })

  it('exports the setup as a profile and imports one: merged, or replacing the catalogue while no order exists', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    const exported = await a.call('tech.exportProfile')
    expect(exported).toMatchObject({ ok: true, value: { fileName: expect.stringMatching(/^atlas-\d{4}-\d{2}-\d{2}\.atlasprofile$/) } })
    const bytes = (exported as { value: { bytes: Uint8Array } }).value.bytes
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b])
    const file = join(a.root, 'copy.atlasprofile')
    writeFileSync(file, bytes)

    // Merged: the same products are found by name, none is added.
    expect(await a.call('tech.importProfile', { path: file, replaceCatalog: false })).toMatchObject({ ok: true, value: { catalog: 'merged', productsCreated: 0 } })
    // Replaced: no order yet.
    expect(await a.call('tech.importProfile', { path: file, replaceCatalog: true })).toMatchObject({ ok: true, value: { catalog: 'replaced', productsCreated: 49 } })
    const db = openDatabase(a.paths.dbFile)
    expect(db.prepare('SELECT COUNT(*) FROM products').pluck().get()).toBe(49)
    expect(db.prepare('SELECT COUNT(*) FROM tables').pluck().get()).toBe(20)
    expect(db.prepare("SELECT COUNT(*) FROM backup_runs WHERE kind = 'pre-change'").pluck().get()).toBe(2)
    // An order exists: the catalogue is no longer replaceable.
    db.prepare("INSERT INTO business_days (id, number, opened_at) VALUES ('d1', 1, 'x')").run()
    db.prepare("INSERT INTO orders (id, day_id, type, user_id, opened_at, updated_at) VALUES ('o1', 'd1', 'counter', 'u', 'x', 'x')").run()
    db.close()
    expect(await a.call('tech.importProfile', { path: file, replaceCatalog: true })).toMatchObject({ ok: false, error: { code: 'existing_data' } })
    expect(await a.call('tech.importProfile', { path: join(a.root, 'nothing'), replaceCatalog: false })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await a.call('tech.importProfile', { bytes: new Uint8Array([1, 2, 3]), replaceCatalog: false })).toMatchObject({ ok: false, error: { code: 'invalid_profile' } })
  })

  it('shows the last log lines, oldest first', async () => {
    const a = await technician()
    await a.call('users.verifyTechnician', { code: TECH_CODE })
    writeFileSync(
      join(a.paths.logs, 'app.log'),
      [
        '{"level":30,"time":1761200000000,"pid":1,"event":"app.start","version":"0.1.0"}',
        'not json',
        '{"level":50,"time":1761200001000,"pid":1,"event":"print.failed","jobId":"j1"}',
        '{"level":40,"time":1761200002000,"pid":1,"event":"backup.copy_failed"}'
      ].join('\n') + '\n'
    )
    const all = await a.call('tech.logs', { tail: 10 })
    expect(all).toMatchObject({
      ok: true,
      value: [
        { level: 'info', event: 'app.start', data: { version: '0.1.0' } },
        { level: 'error', event: 'print.failed', data: { jobId: 'j1' } },
        { level: 'warn', event: 'backup.copy_failed' }
      ]
    })
    expect((all as { value: { time: string }[] }).value[0]!.time).toBe(new Date(1761200000000).toISOString())
    expect(await a.call('tech.logs', { tail: 1 })).toMatchObject({ ok: true, value: [{ event: 'backup.copy_failed' }] })
    expect(await a.call('tech.logs', { tail: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('restores a backup and quits to the desktop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const a = await technician()
      await a.call('users.verifyTechnician', { code: TECH_CODE })
      expect(await a.call('backup.run')).toMatchObject({ ok: true })
      const listed = (await a.call('backup.list')) as { value: { file: string; kind: string }[] }
      const manual = listed.value.find((e) => e.kind === 'manual')!
      expect(await a.call('tech.restore', { file: manual.file })).toEqual({ ok: true, value: { route: '#/login' } })
      expect(a.shell.navigateTill).toHaveBeenCalledWith('#/login')
      // Restoring signs everybody out, the technician mode included.
      expect(await a.call('tech.logs')).toMatchObject({ ok: false, error: { code: 'forbidden' } })

      await a.call('users.verifyTechnician', { code: TECH_CODE })
      expect(await a.call('tech.quitToDesktop')).toEqual({ ok: true, value: true })
      vi.runAllTimers()
      expect(a.shell.quitToDesktop).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

