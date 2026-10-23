import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/main/application/events'
import type { DomainEvent } from '../../../src/main/application/events'
import { startupCheck } from '../../../src/main/application/usecases/startup/startup-check'
import { createSettingsRepo } from '../../../src/main/infrastructure/db/repos/settings-repo'
import { createBackupEngine, type BackupEngine, type BackupEngineDeps } from '../../../src/main/infrastructure/backup/engine'
import {
  copyFileAtomic,
  folderTarget,
  usbTarget,
  type BackupTarget
} from '../../../src/main/infrastructure/backup/targets'
import { usbScan } from '../../../src/main/infrastructure/backup/usb-scan'
import {
  addProducts,
  backupFixture,
  manualClock,
  manualScheduler,
  type BackupFixture,
  type ManualClock
} from '../../helpers/backup'

const HOUR = 60 * 60 * 1000

describe('BackupEngine', () => {
  let fx: BackupFixture
  let clock: ManualClock
  let timers: ReturnType<typeof manualScheduler>
  let events: DomainEvent[]
  let logs: { event: string; data?: Record<string, unknown> }[]
  let engine: BackupEngine | undefined

  beforeEach(() => {
    fx = backupFixture(5)
    clock = manualClock('2026-10-22T10:00:00.000Z')
    timers = manualScheduler(clock)
    events = []
    logs = []
    engine = undefined
  })
  afterEach(async () => {
    if (engine) {
      engine.stop()
      await engine.idle()
    }
    fx.cleanup()
  })

  function makeEngine(targets: BackupTarget[], extra: Partial<BackupEngineDeps> = {}): BackupEngine {
    const bus = createEventBus()
    bus.subscribe('backup.status', (e) => events.push(e))
    engine = createBackupEngine({
      db: fx.db,
      paths: fx.paths,
      targets: () => targets,
      clock,
      settings: createSettingsRepo(fx.db),
      log: (event, data) => logs.push(data ? { event, data } : { event }),
      eventBus: bus,
      appVersion: '0.1.0',
      schedule: timers.schedule,
      ...extra
    })
    return engine
  }

  const runRows = () =>
    fx.db.prepare('SELECT kind, file_name AS fileName, results_json AS results FROM backup_runs ORDER BY at, rowid').all() as {
      kind: string
      fileName: string
      results: string
    }[]

  it('coalesces 5 ticket closes within 60 s into one live copy that holds all of them', async () => {
    const disk = fx.newDir('disk')
    let liveWrites = 0
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })], {
      io: {
        copyFile: async (src, dest) => {
          if (dest.endsWith('atlas-live.atlasbak')) liveWrites++
          await copyFileAtomic(src, dest)
        }
      }
    })

    for (let i = 0; i < 5; i++) {
      addProducts(fx.db, 1)
      e.onTicketClosed()
      timers.advance(10_000)
      await e.idle()
    }
    expect(liveWrites).toBe(0)
    timers.advance(10_000) // 60 s after the first close
    await e.idle()
    expect(liveWrites).toBe(1)

    const live = join(disk, 'AtlasBackup', 'live', 'atlas-live.atlasbak')
    const manifest = JSON.parse(readFileSync(`${live}.json`, 'utf8'))
    expect(manifest.kind).toBe('live')
    expect(manifest.counts.products).toBe(10)
    expect(existsSync(join(fx.paths.backups, 'live', 'atlas-live.atlasbak'))).toBe(true)

    timers.advance(5 * 60_000)
    await e.idle()
    expect(liveWrites).toBe(1)

    e.onTicketClosed()
    timers.advance(60_000)
    await e.idle()
    expect(liveWrites).toBe(2)
    expect(runRows().map((r) => r.kind)).toEqual(['live', 'live'])
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })

  it('a close during a live copy schedules one more copy, never drops the last ticket', async () => {
    const disk = fx.newDir('disk')
    let release: (() => void) | undefined
    let liveWrites = 0
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })], {
      io: {
        copyFile: async (src, dest) => {
          if (dest.endsWith('atlas-live.atlasbak')) {
            liveWrites++
            if (liveWrites === 1) await new Promise<void>((r) => (release = r))
          }
          await copyFileAtomic(src, dest)
        }
      }
    })

    e.onTicketClosed()
    timers.advance(60_000)
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 5))
    expect(release).toBeDefined()
    addProducts(fx.db, 2)
    e.onTicketClosed() // arrives while the first copy is in flight
    release?.()
    await e.idle()
    expect(liveWrites).toBe(1)
    timers.advance(60_000)
    await e.idle()
    expect(liveWrites).toBe(2)
    const manifest = JSON.parse(readFileSync(join(disk, 'AtlasBackup', 'live', 'atlas-live.atlasbak.json'), 'utf8'))
    expect(manifest.counts.products).toBe(7)
  })

  it('does nothing on ticket close when backup.continuous is off', async () => {
    const disk = fx.newDir('disk')
    fx.db
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('backup.continuous', 'false', clock.now().toISOString())
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })])
    e.onTicketClosed()
    timers.advance(120_000)
    await e.idle()
    expect(existsSync(join(disk, 'AtlasBackup'))).toBe(false)
    expect(runRows()).toEqual([])
  })

  it('runFull writes the dated copy to every target and locally, and records one result per destination', async () => {
    const disk = fx.newDir('disk')
    const nas = fx.newDir('nas')
    const e = makeEngine([
      folderTarget({ id: 'd', role: 'disk', path: disk }),
      folderTarget({ id: 'n', role: 'nas', path: nas })
    ])

    const result = await e.runFull('full', 'Z12')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fileName).toMatch(/^atlas-\d{8}-\d{4}-full-Z12\.atlasbak$/)
    for (const root of [disk, nas]) {
      expect(existsSync(join(root, 'AtlasBackup', 'full', result.fileName))).toBe(true)
      expect(existsSync(join(root, 'AtlasBackup', 'full', `${result.fileName}.json`))).toBe(true)
    }
    expect(existsSync(join(fx.paths.backups, result.fileName))).toBe(true)
    expect(existsSync(join(fx.paths.backups, `${result.fileName}.json`))).toBe(true)

    const rows = runRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('full')
    expect(rows[0]!.fileName).toBe(result.fileName)
    expect(JSON.parse(rows[0]!.results)).toEqual([
      { targetId: 'd', role: 'disk', ok: true, file: join(disk, 'AtlasBackup', 'full', result.fileName) },
      { targetId: 'n', role: 'nas', ok: true, file: join(nas, 'AtlasBackup', 'full', result.fileName) }
    ])
    expect(e.status()).toEqual({
      lastOkAt: '2026-10-22T10:00:00.000Z',
      overall: 'ok',
      perTarget: [
        { id: 'd', role: 'disk', lastOkAt: '2026-10-22T10:00:00.000Z', lastError: null, state: 'ok' },
        { id: 'n', role: 'nas', lastOkAt: '2026-10-22T10:00:00.000Z', lastError: null, state: 'ok' }
      ]
    })
    expect(events).toEqual([{ type: 'backup.status', status: 'ok' }])
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])

    // startupCheck reads the run as the last backup.
    fx.db.pragma('wal_checkpoint(TRUNCATE)')
    expect(startupCheck({ paths: fx.paths, clock, unclean: false }).lastBackupAt).toBe('2026-10-22T10:00:00.000Z')
  })

  it('two manual backups in the same minute get distinct names', async () => {
    const e = makeEngine([])
    const a = await e.runFull('manual')
    const b = await e.runFull('manual')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.fileName).toBe(a.fileName.replace(/\.atlasbak$/, '-2.atlasbak'))
  })

  it('a missing USB is pending, then copied by retryPending once its marker appears', async () => {
    const disk = fx.newDir('disk')
    const mount = fx.newDir('usb')
    const usb = usbTarget({ id: 'u', targetKey: 'key-usb', label: 'Clé' }, (key) =>
      usbScan(key, { platform: 'linux', listCandidateRoots: async () => [mount] })
    )
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk }), usb])

    const result = await e.runFull('full')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(e.status().perTarget.find((t) => t.id === 'u')).toEqual({
      id: 'u',
      role: 'usb',
      lastOkAt: null,
      lastError: null,
      state: 'pending'
    })
    expect(e.status().overall).toBe('ok')
    expect(JSON.parse(runRows()[0]!.results)[1]).toEqual({ targetId: 'u', role: 'usb', ok: false, error: 'unavailable' })

    // Nothing to copy while it is still away.
    clock.advance(60_000)
    await e.retryPending()
    expect(e.status().perTarget.find((t) => t.id === 'u')?.state).toBe('pending')

    mkdirSync(join(mount, 'AtlasBackup'), { recursive: true })
    writeFileSync(join(mount, 'AtlasBackup', '.atlas-target'), 'key-usb\n')
    await e.retryPending()

    expect(existsSync(join(mount, 'AtlasBackup', 'full', result.fileName))).toBe(true)
    expect(existsSync(join(mount, 'AtlasBackup', 'full', `${result.fileName}.json`))).toBe(true)
    expect(e.status().perTarget.find((t) => t.id === 'u')).toEqual({
      id: 'u',
      role: 'usb',
      lastOkAt: '2026-10-22T10:01:00.000Z',
      lastError: null,
      state: 'ok'
    })
    expect(JSON.parse(runRows()[0]!.results)[1]).toEqual({
      targetId: 'u',
      role: 'usb',
      ok: true,
      file: join(mount, 'AtlasBackup', 'full', result.fileName)
    })
  })

  it('retryPending runs every 60 s once started', async () => {
    const mount = fx.newDir('usb')
    const usb = usbTarget({ id: 'u', targetKey: 'key-usb' }, (key) =>
      usbScan(key, { platform: 'linux', listCandidateRoots: async () => [mount] })
    )
    const e = makeEngine([usb])
    const result = await e.runFull('full')
    if (!result.ok) throw new Error('backup failed')
    e.start()
    mkdirSync(join(mount, 'AtlasBackup'), { recursive: true })
    writeFileSync(join(mount, 'AtlasBackup', '.atlas-target'), 'key-usb')
    timers.advance(60_000)
    await e.idle()
    expect(existsSync(join(mount, 'AtlasBackup', 'full', result.fileName))).toBe(true)
    expect(e.status().perTarget[0]?.state).toBe('ok')
    e.stop()
    expect(timers.pending).toBe(0)
  })

  it('a target that fails with ENOSPC is in error and the other targets still succeed', async () => {
    const good = fx.newDir('good')
    const full = fx.newDir('full')
    const e = makeEngine(
      [folderTarget({ id: 'g', role: 'disk', path: good }), folderTarget({ id: 'f', role: 'nas', path: full })],
      {
        io: {
          copyFile: async (src, dest) => {
            if (dest.startsWith(full)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
            await copyFileAtomic(src, dest)
          }
        }
      }
    )

    const result = await e.runFull('full')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results).toEqual([
      { targetId: 'g', role: 'disk', ok: true, file: join(good, 'AtlasBackup', 'full', result.fileName) },
      { targetId: 'f', role: 'nas', ok: false, error: 'ENOSPC' }
    ])
    const status = e.status()
    expect(status.perTarget.map((t) => [t.id, t.state, t.lastError])).toEqual([
      ['g', 'ok', null],
      ['f', 'error', 'ENOSPC']
    ])
    expect(status.overall).toBe('error')
    expect(events.at(-1)).toEqual({ type: 'backup.status', status: 'error' })
    expect(logs.some((l) => l.event === 'backup.copy_failed' && l.data?.['targetId'] === 'f')).toBe(true)

    // Ticket closes never throw, even with a broken target.
    expect(() => e.onTicketClosed()).not.toThrow()
    timers.advance(60_000)
    await e.idle()
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })

  it('a target whose last success is older than warnAfterHours is in warning', async () => {
    const disk = fx.newDir('disk')
    fx.db.prepare("INSERT INTO backup_destinations (id, role, path) VALUES ('d', 'disk', ?)").run(disk)
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })])
    await e.runFull('full')

    clock.advance(23 * HOUR)
    expect(e.status().perTarget[0]?.state).toBe('ok')
    clock.advance(2 * HOUR)
    expect(e.status().perTarget[0]?.state).toBe('warning')
    expect(e.status().overall).toBe('warning')

    // The success is stored on the destination, so a new engine (after a restart) knows it too.
    expect(fx.db.prepare("SELECT last_ok_at AS at, last_error AS err FROM backup_destinations WHERE id = 'd'").get()).toEqual({
      at: '2026-10-22T10:00:00.000Z',
      err: null
    })
    e.stop()
    const restarted = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })])
    expect(restarted.status().perTarget[0]).toEqual({
      id: 'd',
      role: 'disk',
      lastOkAt: '2026-10-22T10:00:00.000Z',
      lastError: null,
      state: 'warning'
    })
  })

  it('the 60 s tick publishes the warning that time alone brings', async () => {
    const disk = fx.newDir('disk')
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })])
    await e.runFull('full')
    e.start()
    events.length = 0
    timers.advance(25 * HOUR)
    await e.idle()
    expect(events).toEqual([{ type: 'backup.status', status: 'warning' }])
  })

  it('rotates the full backups after each run, locally and on the targets', async () => {
    const disk = fx.newDir('disk')
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: disk })])
    // 13 Jul is past retention and not its month's newest (14 Jul is): the only one to go.
    const oldName = 'atlas-20260713-0900-full.atlasbak'
    for (const dir of [fx.paths.backups, join(disk, 'AtlasBackup', 'full')]) {
      mkdirSync(dir, { recursive: true })
      for (const name of [oldName, 'atlas-20260714-0900-full.atlasbak', 'atlas-20260801-0900-full.atlasbak', 'atlas-20260802-0900-full.atlasbak']) {
        writeFileSync(join(dir, name), 'x')
        writeFileSync(join(dir, `${name}.json`), '{}')
      }
    }
    await e.runFull('full')
    expect(existsSync(join(fx.paths.backups, oldName))).toBe(false)
    expect(existsSync(join(disk, 'AtlasBackup', 'full', oldName))).toBe(false)
    expect(existsSync(join(disk, 'AtlasBackup', 'full', `${oldName}.json`))).toBe(false)
    for (const kept of ['atlas-20260714-0900-full.atlasbak', 'atlas-20260801-0900-full.atlasbak', 'atlas-20260802-0900-full.atlasbak']) {
      expect(existsSync(join(fx.paths.backups, kept))).toBe(true)
      expect(existsSync(join(disk, 'AtlasBackup', 'full', kept))).toBe(true)
    }
  })

  it('runFull reports a failed snapshot instead of throwing', async () => {
    const e = makeEngine([folderTarget({ id: 'd', role: 'disk', path: fx.newDir('disk') })])
    fx.db.close()
    const result = await e.runFull('manual')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_snapshot_failed')
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })
})
