import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../../src/shared/ipc-contract'
import { createEventBus } from '../../../src/main/application/events'
import { createRuntime, type Runtime } from '../../../src/main/composition/runtime'
import { openDatabase } from '../../../src/main/infrastructure/db/connection'
import { migrate } from '../../../src/main/infrastructure/db/migrate'
import { writeInstallation } from '../../../src/main/infrastructure/fs/installation'
import type { IpcDeps, ShellPorts } from '../../../src/main/interfaces/ipc/context'
import { forwardEvents } from '../../../src/main/interfaces/ipc/events'
import { dispatch } from '../../../src/main/interfaces/ipc/register'
import { createSessionStore } from '../../../src/main/interfaces/ipc/session-store'
import type { Logger } from '../../../src/main/logger'
import { ensureDataLayout, type DataPaths } from '../../../src/main/paths'
import { hashSecret } from '../../../src/main/infrastructure/security/password'
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
function seeded(): { paths: DataPaths; users: ReturnType<typeof seedUsers>['users'] } {
  const paths = dataDir()
  install(paths)
  const db = openDatabase(paths.dbFile)
  migrate(db)
  const { users } = seedUsers(db)
  db.close()
  return { paths, users }
}

function boot(paths: DataPaths) {
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
  const shell = { appVersion: '0.1.0', navigateTill: vi.fn() } as unknown as ShellPorts & { navigateTill: ReturnType<typeof vi.fn> }
  const deps: IpcDeps = { paths, runtime, shell, log: logger }
  const sessions = createSessionStore()
  const call = (channel: Channel, input: unknown, windowId = 1) => dispatch(channel, windowId, input, deps, sessions)
  return { runtime, call, shell, sessions }
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
