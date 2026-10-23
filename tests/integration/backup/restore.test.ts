import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/main/application/events'
import { openDatabase, openDatabaseReadOnly } from '../../../src/main/infrastructure/db/connection'
import { createSettingsRepo } from '../../../src/main/infrastructure/db/repos/settings-repo'
import { createBackupEngine } from '../../../src/main/infrastructure/backup/engine'
import { listBackups, restoreBackup } from '../../../src/main/infrastructure/backup/restore'
import { createSnapshot } from '../../../src/main/infrastructure/backup/snapshot'
import { copyFileAtomic, folderTarget, type BackupTarget } from '../../../src/main/infrastructure/backup/targets'
import { addProducts, backupFixture, countProducts, manualClock, type BackupFixture } from '../../helpers/backup'

describe('listBackups / restoreBackup', () => {
  let fx: BackupFixture
  let disk: string
  let target: BackupTarget
  const clock = manualClock('2026-10-22T10:00:00.000Z')

  beforeEach(() => {
    fx = backupFixture(5)
    disk = fx.newDir('disk')
    target = folderTarget({ id: 'd', role: 'disk', path: disk })
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
      error: { code: 'newer_schema', messageKey: 'errors.newer_schema', params: { found: 99, supported: 1 } }
    })
    expect(closed).toBe(false)
    expect(fx.db.open).toBe(true)
    expect(countProducts(fx.db)).toBe(5)
    expect(readdirSync(fx.paths.db).filter((n) => n.startsWith('pre-restore'))).toEqual([])
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
