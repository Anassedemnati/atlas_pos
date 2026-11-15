import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '@shared/ids'
import type { Database } from '../../../src/main/infrastructure/db/connection'
import { createEventBus } from '../../../src/main/application/events'
import * as startup from '../../../src/main/application/usecases/startup/startup-check'
import * as migrateModule from '../../../src/main/infrastructure/db/migrate'
import { openDatabase, openDatabaseReadOnly } from '../../../src/main/infrastructure/db/connection'
import { createSettingsRepo } from '../../../src/main/infrastructure/db/repos/settings-repo'
import { createBackupEngine } from '../../../src/main/infrastructure/backup/engine'
import { listBackups, restoreBackup } from '../../../src/main/infrastructure/backup/restore'
import { createSnapshot } from '../../../src/main/infrastructure/backup/snapshot'
import { migrations } from '../../../src/main/infrastructure/db/migrate'
import { copyFileAtomic, type BackupTarget } from '../../../src/main/infrastructure/backup/targets'
import { addProducts, backupFixture, countProducts, manualClock, markedFolder, type BackupFixture } from '../../helpers/backup'

// Pass-through mocks: a test can make one migrate / startupCheck call fail.
vi.mock('../../../src/main/infrastructure/db/migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/infrastructure/db/migrate')>()
  return { ...actual, migrate: vi.fn(actual.migrate) }
})
vi.mock('../../../src/main/application/usecases/startup/startup-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/application/usecases/startup/startup-check')>()
  return { ...actual, startupCheck: vi.fn(actual.startupCheck) }
})

const COUNTED = ['tickets', 'orders', 'order_lines', 'products', 'users', 'z_reports'] as const
const countsOf = (db: Database): Record<string, number> =>
  Object.fromEntries(COUNTED.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]))

/** A closed day: a user, an order with 2 lines, its ticket and the Z report. */
function seedSale(db: Database): void {
  const at = '2026-10-22T09:00:00.000Z'
  const profile = newId()
  const user = newId()
  const day = newId()
  const order = newId()
  const product = (db.prepare('SELECT id FROM products LIMIT 1').get() as { id: string }).id
  db.prepare("INSERT INTO profiles (id, name_json, permissions_json) VALUES (?, '{}', '[]')").run(profile)
  db.prepare("INSERT INTO users (id, display_name, pin_hash, profile_id, created_at) VALUES (?, 'Gérant', 'h', ?, ?)").run(user, profile, at)
  db.prepare('INSERT INTO business_days (id, number, opened_at, closed_at) VALUES (?, 1, ?, ?)').run(day, at, at)
  db.prepare(
    "INSERT INTO orders (id, day_id, type, status, user_id, opened_at, updated_at) VALUES (?, ?, 'counter', 'closed', ?, ?, ?)"
  ).run(order, day, user, at, at)
  for (const seq of [1, 2]) {
    db.prepare(
      `INSERT INTO order_lines (id, order_id, seq, product_id, name_json, qty_milli, unit_price_cents, vat_bp, user_id, created_at)
       VALUES (?, ?, ?, ?, '{}', 1000, 1500, 2000, ?, ?)`
    ).run(newId(), order, seq, product, user, at)
  }
  db.prepare(
    `INSERT INTO tickets (id, kind, number, label, order_id, day_id, closed_at, user_id, total_cents, snapshot_json)
     VALUES (?, 'sale', 1, '000001', ?, ?, ?, ?, 3000, '{}')`
  ).run(newId(), order, day, at, user)
  db.prepare("INSERT INTO z_reports (id, day_id, number, data_json, created_at, user_id) VALUES (?, ?, 1, '{}', ?, ?)").run(
    newId(),
    day,
    at,
    user
  )
}

describe('listBackups / restoreBackup', () => {
  let fx: BackupFixture
  let disk: string
  let target: BackupTarget
  const clock = manualClock('2026-10-22T10:00:00.000Z')

  beforeEach(() => {
    fx = backupFixture(5)
    disk = fx.newDir('disk')
    target = markedFolder({ id: 'd', role: 'disk', path: disk })
  })
  afterEach(() => fx.cleanup())

  async function backupNow(): Promise<string> {
    const engine = createBackupEngine({
      db: fx.db,
      paths: fx.paths,
      targets: () => [target],
      clock,
      settings: createSettingsRepo(fx.db),
      log: () => {},
      eventBus: createEventBus(),
      appVersion: '0.1.0'
    })
    const result = await engine.runFull('full', 'Z1')
    engine.stop()
    if (!result.ok) throw new Error('backup failed')
    return result.fileName
  }

  it('lists the backups found on the targets and in the local folder, newest first', async () => {
    const fileName = await backupNow()
    const entries = await listBackups([target], fx.paths.backups)
    expect(entries.map((e) => [e.source, e.fileName, e.manifest.kind, e.manifest.counts.products])).toEqual([
      ['d', fileName, 'full', 5],
      ['local', fileName, 'full', 5]
    ])
    expect(entries[0]!.file).toBe(join(disk, 'AtlasBackup', 'full', fileName))
  })

  it('a restore round trip gives the backup counts back and keeps the current DB as pre-restore', async () => {
    await backupNow()
    addProducts(fx.db, 3)
    expect(countProducts(fx.db)).toBe(8)
    const [entry] = await listBackups([target])

    const result = await restoreBackup(entry!, fx.paths, { clock, close: () => fx.db.close() })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fx.db.open).toBe(false)
    expect(result.value.report.state).toBe('ok')
    const restored = openDatabase(fx.paths.dbFile)
    try {
      expect(countProducts(restored)).toBe(entry!.manifest.counts.products)
      expect(countProducts(restored)).toBe(5)
    } finally {
      restored.close()
    }
    const pre = result.value.preRestoreFile
    expect(pre).toBe(join(fx.paths.db, 'pre-restore-20261022T100000000Z.db'))
    expect(existsSync(pre!)).toBe(true)
    const old = openDatabaseReadOnly(pre!)
    try {
      expect(countProducts(old)).toBe(8)
    } finally {
      old.close()
    }
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })

  it('a restore round trip with sales gives back the counts of all six tables', async () => {
    seedSale(fx.db)
    const before = countsOf(fx.db)
    expect(before).toEqual({ tickets: 1, orders: 1, order_lines: 2, products: 5, users: 1, z_reports: 1 })
    await backupNow()
    addProducts(fx.db, 2)
    const [entry] = await listBackups([target])
    expect(entry!.manifest.counts).toEqual(before)

    const result = await restoreBackup(entry!, fx.paths, { clock, close: () => fx.db.close() })

    expect(result.ok).toBe(true)
    const restored = openDatabaseReadOnly(fx.paths.dbFile)
    try {
      expect(countsOf(restored)).toEqual(before)
    } finally {
      restored.close()
    }
  })

  for (const failing of ['migrate', 'check'] as const) {
    it(`rolls back when the ${failing === 'migrate' ? 'migration' : 'start-up check'} fails: previous files restored, the restored file set aside`, async () => {
      await backupNow()
      addProducts(fx.db, 3)
      const [entry] = await listBackups([target])
      fx.db.close()
      writeFileSync(`${fx.paths.dbFile}-shm`, 'stale shm')
      if (failing === 'migrate') {
        vi.mocked(migrateModule.migrate).mockImplementationOnce(() => {
          throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })
        })
      } else {
        vi.mocked(startup.startupCheck).mockImplementationOnce(() => {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        })
      }

      const result = await restoreBackup(entry!, fx.paths, { clock })

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'restore_failed',
          messageKey: 'errors.restore_failed',
          params: { stage: failing, reason: failing === 'migrate' ? 'SQLITE_IOERR' : 'SQLITE_BUSY' }
        }
      })
      const names = readdirSync(fx.paths.db)
      expect(names.filter((n) => n.startsWith('pre-restore'))).toEqual([])
      expect(names.filter((n) => /^restore-failed-.+\.db$/.test(n))).toHaveLength(1)
      expect(readFileSync(`${fx.paths.dbFile}-shm`, 'utf8')).toBe('stale shm')
      const current = openDatabaseReadOnly(fx.paths.dbFile)
      try {
        expect(countProducts(current)).toBe(8) // the database from before the restore
      } finally {
        current.close()
      }
      expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
    })
  }

  it('moves stale -wal and -shm files aside together with the database', async () => {
    await backupNow()
    const [entry] = await listBackups([target])
    fx.db.close()
    writeFileSync(`${fx.paths.dbFile}-wal`, 'stale wal')
    writeFileSync(`${fx.paths.dbFile}-shm`, 'stale shm')

    const result = await restoreBackup(entry!, fx.paths, { clock })

    expect(result.ok).toBe(true)
    const pre = join(fx.paths.db, 'pre-restore-20261022T100000000Z.db')
    expect(readFileSync(`${pre}-wal`, 'utf8')).toBe('stale wal')
    expect(readFileSync(`${pre}-shm`, 'utf8')).toBe('stale shm')
    const restored = openDatabaseReadOnly(fx.paths.dbFile)
    try {
      expect(countProducts(restored)).toBe(5)
    } finally {
      restored.close()
    }
  })

  it('restores when there is no current database at all', async () => {
    await backupNow()
    const [entry] = await listBackups([target])
    fx.db.close()
    rmSync(fx.paths.dbFile)

    const result = await restoreBackup(entry!, fx.paths, { clock })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.preRestoreFile).toBeNull()
    const restored = openDatabaseReadOnly(fx.paths.dbFile)
    try {
      expect(countProducts(restored)).toBe(5)
    } finally {
      restored.close()
    }
  })

  it('refuses a backup written by a newer schema and leaves the current database alone', async () => {
    const other = backupFixture(2)
    try {
      other.db.pragma('user_version = 99')
      const snap = await createSnapshot(other.db, join(other.paths.backups, 'tmp'), {
        kind: 'manual',
        appVersion: '9.0.0',
        installationId: 'inst-test',
        createdAt: clock.now()
      })
      const fileName = 'atlas-20261022-1000-manual.atlasbak'
      mkdirSync(join(disk, 'AtlasBackup', 'full'), { recursive: true })
      await copyFileAtomic(snap.file, join(disk, 'AtlasBackup', 'full', fileName))
      await copyFileAtomic(`${snap.file}.json`, join(disk, 'AtlasBackup', 'full', `${fileName}.json`))
    } finally {
      other.cleanup()
    }
    const [entry] = await listBackups([target])
    let closed = false

    const result = await restoreBackup(entry!, fx.paths, { clock, close: () => (closed = true) })

    expect(result).toEqual({
      ok: false,
      error: { code: 'newer_schema', messageKey: 'errors.newer_schema', params: { found: 99, supported: migrations.length } }
    })
    expect(closed).toBe(false)
    expect(fx.db.open).toBe(true)
    expect(countProducts(fx.db)).toBe(5)
    expect(readdirSync(fx.paths.db).filter((n) => n.startsWith('pre-restore'))).toEqual([])
  })

  it('reports a close that throws as restore_failed, with nothing moved', async () => {
    await backupNow()
    const [entry] = await listBackups([target])

    const result = await restoreBackup(entry!, fx.paths, {
      clock,
      close: () => {
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
      }
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'restore_failed',
        messageKey: 'errors.restore_failed',
        params: { stage: 'close', reason: 'SQLITE_BUSY' }
      }
    })
    expect(existsSync(fx.paths.dbFile)).toBe(true)
    expect(countProducts(fx.db)).toBe(5)
    expect(readdirSync(fx.paths.db).filter((n) => n.startsWith('pre-restore'))).toEqual([])
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })

  it('refuses a tampered backup without touching the current database', async () => {
    const fileName = await backupNow()
    const file = join(disk, 'AtlasBackup', 'full', fileName)
    const bytes = readFileSync(file)
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff
    writeFileSync(file, bytes)
    const [entry] = await listBackups([target])

    const result = await restoreBackup(entry!, fx.paths, { clock, close: () => fx.db.close() })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_checksum_mismatch')
    expect(fx.db.open).toBe(true)
    expect(readdirSync(fx.paths.db).filter((n) => n.startsWith('pre-restore'))).toEqual([])
    expect(readdirSync(join(fx.paths.backups, 'tmp'))).toEqual([])
  })
})
