import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../../src/shared/ipc-contract'
import { createEventBus } from '../../../src/main/application/events'
import { createRuntime, type Runtime } from '../../../src/main/composition/runtime'
import { openDatabase } from '../../../src/main/infrastructure/db/connection'
import { migrate, migrations } from '../../../src/main/infrastructure/db/migrate'
import { writeInstallation } from '../../../src/main/infrastructure/fs/installation'
import type { IpcDeps, ShellPorts } from '../../../src/main/interfaces/ipc/context'
import { forwardEvents } from '../../../src/main/interfaces/ipc/events'
import { dispatch } from '../../../src/main/interfaces/ipc/register'
import { createSessionStore } from '../../../src/main/interfaces/ipc/session-store'
import type { Logger } from '../../../src/main/logger'
import { ensureDataLayout, type DataPaths } from '../../../src/main/paths'
import { hashSecret } from '../../../src/main/infrastructure/security/password'
import { testSetupService } from '../../helpers/setup'
import { PINS, TECHNICIAN_CODE, seedUsers } from '../../helpers/users'

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const log = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() })

function dataDir(): DataPaths {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-shell-'))
  dirs.push(dir)
  return ensureDataLayout(dir)
}

function install(paths: DataPaths): void {
  const now = '2026-10-22T08:00:00.000Z'
  writeInstallation(paths, { installationId: 'inst-1', createdAt: now, setupCompletedAt: now, appVersion: '0.1.0' })
}

/** A completed installation: installation.json, a migrated database, three users. */
function seeded(schemaVersion = migrations.length): { paths: DataPaths; users: ReturnType<typeof seedUsers>['users'] } {
  const paths = dataDir()
  install(paths)
  const db = openDatabase(paths.dbFile)
  migrate(db, migrations.slice(0, schemaVersion))
  const { users } = seedUsers(db)
  db.close()
  return { paths, users }
}

function boot(paths: DataPaths, options: { safeMode?: boolean } = {}) {
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
    safeMode: options.safeMode ?? false
  })
  runtimes.push(runtime)
  runtime.boot()
  const shell = { appVersion: '0.1.0', navigateTill: vi.fn(), restartNormally: vi.fn() } as unknown as ShellPorts & {
    navigateTill: ReturnType<typeof vi.fn>
    restartNormally: ReturnType<typeof vi.fn>
  }
  const durableLog = vi.fn()
  const setup = testSetupService({ paths, log: logger, restore: (file) => runtime.restore(file) })
  const deps: IpcDeps = { paths, runtime, setup, shell, log: logger, durableLog }
  const sessions = createSessionStore()
  const call = (channel: Channel, input: unknown, windowId = 1) => dispatch(channel, windowId, input, deps, sessions)
  return { runtime, call, shell, sessions, durableLog }
}

describe('runtime and IPC on a real data directory', () => {
  it('opens a fresh installation on the setup route, with no database and no use cases', async () => {
    const paths = dataDir()
    const { runtime, call } = boot(paths)
    expect(runtime.status()).toMatchObject({ route: '#/setup', ready: false, report: { state: 'needs-setup' } })
    expect(runtime.services()).toBeNull()
    expect(await call('app.startupReport', {})).toMatchObject({ ok: true, value: { route: '#/setup', ready: false, version: '0.1.0' } })
    expect(await call('users.listTill', {})).toMatchObject({ ok: false, error: { code: 'app_not_ready' } })
    expect(await call('backup.list', {})).toMatchObject({ ok: false, error: { code: 'app_not_ready' } })
  })

  it('lets a corrupt installation list its backups without signing in (nobody can)', async () => {
    const paths = dataDir()
    install(paths)
    writeFileSync(paths.dbFile, 'not a database at all, not even close'.repeat(200))
    const { runtime, call } = boot(paths)
    expect(runtime.status()).toMatchObject({ route: '#/recovery?mode=corrupt', ready: false })
    expect(await call('backup.list', {})).toEqual({ ok: true, value: [] })
    expect(await call('backup.restore', { file: join(paths.backups, 'nope.atlasbak') })).toMatchObject({
      ok: false,
      error: { code: 'backup_not_found' }
    })
  })

  it('signs users in per window and re-reads them on every call', async () => {
    const { paths, users } = seeded()
    const { runtime, call } = boot(paths)
    expect(runtime.status()).toMatchObject({ route: '#/login', ready: true })

    expect(await call('users.loginPin', { userId: users.amine, pin: PINS.amine }, 1)).toMatchObject({ ok: true, value: { userId: users.amine } })
    expect(await call('users.loginPin', { userId: users.sara, pin: PINS.sara }, 2)).toMatchObject({
      ok: true,
      value: { userId: users.sara, maxDiscountBp: 1000 }
    })
    expect(await call('catalog.list', {}, 3)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    expect(await call('days.gate', {}, 2)).toMatchObject({ ok: true })

    // Deactivated by a manager since: the next call is refused.
    runtime.services()!.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(users.sara)
    expect(await call('days.gate', {}, 2)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    expect(await call('days.gate', {}, 1)).toMatchObject({ ok: true })
  })

  it('restores a backup: the services are rebuilt on it, everyone signs in again, the till is reloaded', async () => {
    const { paths, users } = seeded()
    const { runtime, call, shell } = boot(paths)
    await call('users.loginPin', { userId: users.amine, pin: PINS.amine })

    const run = await call('backup.run', {})
    expect(run).toMatchObject({ ok: true })
    const listed = await call('backup.list', {})
    if (!listed.ok) throw new Error('listing failed')
    const entry = (listed.value as { file: string; kind: string }[]).find((e) => e.kind === 'manual')
    expect(entry).toBeDefined()

    expect(await call('customers.save', { name: 'Après la sauvegarde' })).toMatchObject({ ok: true })
    const before = runtime.services()

    const restored = await call('backup.restore', { file: entry!.file })
    expect(restored).toEqual({ ok: true, value: { route: '#/login' } })
    expect(shell.navigateTill).toHaveBeenCalledWith('#/login')
    expect(runtime.services()).not.toBe(before)
    expect(await call('users.current', {})).toEqual({ ok: true, value: null })

    await call('users.loginPin', { userId: users.amine, pin: PINS.amine })
    expect(await call('customers.search', { q: 'Après' })).toEqual({ ok: true, value: [] })
  })

  it('restores a corrupt installation without sign-in, recorded in the durable log, and opens it', async () => {
    const { paths, users } = seeded()
    const first = boot(paths)
    await first.call('users.loginPin', { userId: users.amine, pin: PINS.amine })
    expect(await first.call('backup.run', {})).toMatchObject({ ok: true })
    await first.runtime.shutdown()
    writeFileSync(paths.dbFile, 'garbage '.repeat(1000))

    const { runtime, call, shell, durableLog } = boot(paths)
    expect(runtime.status()).toMatchObject({ route: '#/recovery?mode=corrupt', ready: false })
    const listed = await call('backup.list', {})
    const entry = listed.ok ? (listed.value as { file: string }[])[0] : undefined
    expect(entry).toBeDefined()
    expect(await call('backup.restore', { file: entry!.file })).toEqual({ ok: true, value: { route: '#/login' } })
    expect(durableLog).toHaveBeenCalledWith('restore.unauthenticated', { file: entry!.file, folder: null })
    expect(shell.navigateTill).toHaveBeenCalledWith('#/login')
    expect(runtime.status()).toMatchObject({ ready: true, report: { state: 'ok' } })
    expect(await call('users.loginPin', { userId: users.amine, pin: PINS.amine })).toMatchObject({ ok: true })
  })

  it('leaves safe mode after a restore: the watchdog is asked for a normal start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const { paths, users } = seeded()
      const { call, shell } = boot(paths, { safeMode: true })
      await call('users.loginPin', { userId: users.amine, pin: PINS.amine })
      expect(await call('app.startupReport', {})).toMatchObject({ ok: true, value: { route: '#/recovery?mode=safe', safeMode: true } })
      await call('backup.run', {})
      const listed = await call('backup.list', {})
      const entry = listed.ok ? (listed.value as { file: string }[])[0] : undefined
      expect(await call('backup.restore', { file: entry!.file })).toMatchObject({ ok: true })
      vi.runAllTimers()
      expect(shell.restartNormally).toHaveBeenCalledOnce()
      expect(shell.navigateTill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies an existing database before migrating it, once', async () => {
    const { paths } = seeded(3)
    const first = boot(paths)
    expect(first.runtime.status()).toMatchObject({ ready: true })
    const copies = readdirSync(paths.backups).filter((name) => /^pre-migration-\d{8}T\d{9}Z-v3\.db$/.test(name))
    expect(copies).toHaveLength(1)
    const copy = openDatabase(join(paths.backups, copies[0]!))
    expect(copy.pragma('user_version', { simple: true })).toBe(3)
    expect(copy.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(3)
    copy.close()
    await first.runtime.shutdown()

    boot(paths)
    expect(readdirSync(paths.backups).filter((name) => name.startsWith('pre-migration-'))).toHaveLength(1)
  })

  it('refuses a restore to a user without backup.restore', async () => {
    const { paths, users } = seeded()
    const { call } = boot(paths)
    await call('users.loginPin', { userId: users.sara, pin: PINS.sara })
    expect(await call('backup.restore', { file: join(paths.backups, 'x.atlasbak') })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'backup.restore' } }
    })
  })

  it('never reads nor writes the technician code through the settings channels', async () => {
    const { paths, users } = seeded()
    const { call } = boot(paths)
    await call('users.loginPin', { userId: users.amine, pin: PINS.amine })
    const all = await call('settings.getAll', {})
    expect(all.ok && Object.keys(all.value as object)).not.toContain('tech.codeHash')
    expect(await call('settings.set', { key: 'tech.codeHash', value: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    // A technician-only setting needs the technician mode, even for a full manager.
    expect(await call('settings.set', { key: 'kiosk.enabled', value: false })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { reason: 'technician' } }
    })
    expect(await call('settings.set', { key: 'receipt.footer', value: 'Merci !' })).toEqual({ ok: true, value: true })
    expect(await call('settings.set', { key: 'receipt.footer', value: 42 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })
})

describe('technician mode', () => {
  it('opens the staff and technician channels on its window only, without a user', async () => {
    const { paths } = seeded()
    const { runtime, call } = boot(paths)
    const services = runtime.services()!
    services.uow.run((tx) => services.settings.set(tx, 'tech.codeHash', hashSecret(TECHNICIAN_CODE)))

    expect(await call('users.verifyTechnician', { code: '000000' }, 4)).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } })
    expect(await call('settings.getAll', {}, 4)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    expect(await call('users.verifyTechnician', { code: TECHNICIAN_CODE }, 4)).toEqual({ ok: true, value: true })
    expect(await call('settings.getAll', {}, 4)).toMatchObject({ ok: true })
    expect(await call('settings.set', { key: 'kiosk.enabled', value: false }, 4)).toEqual({ ok: true, value: true })
    expect(services.settings.get('kiosk.enabled')).toBe(false)
    expect(await call('printing.jobs', {}, 4)).toEqual({ ok: true, value: [] })
    // Manager-level printer actions are open to the technician: the queue itself answers.
    expect(await call('printing.dismissJob', { jobId: 'missing' }, 4)).not.toMatchObject({ error: { code: 'forbidden' } })
    // Another window, and the same window once signed out, are not in technician mode.
    expect(await call('settings.getAll', {}, 5)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    await call('users.logout', {}, 4)
    expect(await call('settings.set', { key: 'kiosk.enabled', value: true }, 4)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })
})

describe('event forwarding', () => {
  it('sends every domain event to the windows', () => {
    const bus = createEventBus()
    const sent: unknown[] = []
    const stop = forwardEvents(bus, (event) => sent.push(event))
    bus.publish({ type: 'order.changed', orderId: 'o1' })
    bus.publish({ type: 'catalog.changed' })
    stop()
    bus.publish({ type: 'catalog.changed' })
    expect(sent).toEqual([{ type: 'order.changed', orderId: 'o1' }, { type: 'catalog.changed' }])
  })
})
