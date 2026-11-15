import { existsSync } from 'node:fs'
import { mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from '@shared/ids'
import type { AppError, Result } from '@shared/result'
import type { Clock } from '../../application/ports'
import { startupCheck, type StartupLog, type StartupReport } from '../../application/usecases/startup/startup-check'
import type { DataPaths } from '../../paths'
import { openDatabase } from '../db/connection'
import { migrate, migrations } from '../db/migrate'
import { readJsonSafe } from '../fs/atomic'
import { expandSnapshot, manifestPath, ManifestSchema, removeDbFiles, type Manifest } from './snapshot'
import { fsyncDir, renameWithRetry, type BackupTarget, type TargetRole } from './targets'
import { BACKUP_DIR } from './usb-scan'

export interface BackupEntry {
  /** The target id, or `local` for `dataDir/backups/`. */
  source: string
  role: TargetRole | 'local'
  /** Absolute path of the `.atlasbak`. */
  file: string
  fileName: string
  manifest: Manifest
}

/** Every `.atlasbak` with a readable manifest in `dir` (not recursive). */
async function entriesIn(dir: string, source: string, role: BackupEntry['role']): Promise<BackupEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: BackupEntry[] = []
  for (const fileName of names.filter((n) => n.endsWith('.atlasbak'))) {
    const file = join(dir, fileName)
    const manifest = readJsonSafe(manifestPath(file), ManifestSchema)
    if (manifest) out.push({ source, role, file, fileName, manifest })
  }
  return out
}

/**
 * The backups that can be restored, newest first (by manifest `createdAt`): `AtlasBackup/full/`
 * and `AtlasBackup/live/` of each available target, then `localDir` (`dataDir/backups/` and its
 * `live/`) when given. A file whose manifest is missing or invalid is not listed.
 */
export async function listBackups(targets: BackupTarget[], localDir?: string): Promise<BackupEntry[]> {
  const found: BackupEntry[] = []
  for (const target of targets) {
    let root: string | null = null
    try {
      root = await target.resolveRoot()
    } catch {
      root = null
    }
    if (!root) continue
    for (const sub of ['full', 'live']) found.push(...(await entriesIn(join(root, BACKUP_DIR, sub), target.id, target.role)))
  }
  if (localDir) {
    found.push(...(await entriesIn(localDir, 'local', 'local')), ...(await entriesIn(join(localDir, 'live'), 'local', 'local')))
  }
  // Stable: for equal times, target order, then local.
  return found.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
}

export interface RestoreDeps {
  clock: Clock
  /** Closes the application's connection to the current database (called only once the backup is verified). */
  close?: () => unknown
  log?: StartupLog
}

export interface RestoreOutcome {
  /** Where the replaced database went (`db/pre-restore-<ts>.db`), or null when there was none. */
  preRestoreFile: string | null
  /** `startupCheck` on the restored database. */
  report: StartupReport
}

const fail = (code: string, params?: Record<string, unknown>): { ok: false; error: AppError } => ({
  ok: false,
  error: { code, messageKey: `errors.${code}`, ...(params ? { params } : {}) }
})

const SUFFIXES = ['', '-wal', '-shm'] as const

/**
 * Renames `from + s` to `to + s` for each suffix present, the database first, recording each
 * suffix in `moved` as soon as it has moved (so a failure half way knows what to put back).
 */
async function moveDbFiles(from: string, to: string, moved: string[] = []): Promise<string[]> {
  for (const s of SUFFIXES) {
    if (!existsSync(`${from}${s}`)) continue
    await renameWithRetry(`${from}${s}`, `${to}${s}`)
    moved.push(s)
  }
  return moved
}

const reasonOf = (error: unknown): string => (error as { code?: string } | null)?.code ?? String(error)

/** `db/pre-restore-<ts>.db`, with `-2`, `-3`... if a restore in the same millisecond already used it. */
function preRestorePath(paths: DataPaths, clock: Clock): string {
  const stamp = clock.now().toISOString().replace(/[-:.]/g, '')
  let candidate = join(paths.db, `pre-restore-${stamp}.db`)
  for (let i = 2; SUFFIXES.some((s) => existsSync(`${candidate}${s}`)); i++) {
    candidate = join(paths.db, `pre-restore-${stamp}-${i}.db`)
  }
  return candidate
}

/**
 * Replaces the database with a backup:
 * 1. refuses a backup whose schema is newer than this app's migrations (`newer_schema`);
 * 2. verifies it (checksum, gunzip, `integrity_check`, counts) into `backups/tmp/`; a backup that
 *    fails leaves everything untouched, the current connection included;
 * 3. closes the current connection (`deps.close`);
 * 4. moves the current database and any `-wal`/`-shm` (the database first) to
 *    `db/pre-restore-<ts>.db*`; a missing current database is fine. A stale `-wal` left next to the
 *    restored file would be replayed into it, so it always goes with the database;
 * 5. fsyncs the verified file, moves it into place, opens it, migrates it, closes it, and runs
 *    `startupCheck`.
 * Never rejects, and either restores completely or not at all. If `close` throws, nothing has
 * moved. If moving, step 5 or `startupCheck` fails, the restored file is set aside as
 * `db/restore-failed-*.db` and the previous files are put back. Both are `restore_failed` with
 * `params.stage`. The caller reopens the database afterwards.
 */
export async function restoreBackup(
  entry: Pick<BackupEntry, 'file'>,
  paths: DataPaths,
  deps: RestoreDeps
): Promise<Result<RestoreOutcome>> {
  const log = deps.log ?? (() => {})
  const manifest = readJsonSafe(manifestPath(entry.file), ManifestSchema)
  if (!manifest) return fail('backup_manifest_invalid')
  if (manifest.schemaVersion > migrations.length) {
    return fail('newer_schema', { found: manifest.schemaVersion, supported: migrations.length })
  }

  const tmpDir = join(paths.backups, 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const staged = join(tmpDir, `restore-${newId()}.db`)
  try {
    const verified = await expandSnapshot(entry.file, staged)
    if (!verified.ok) return verified
    if (verified.value.schemaVersion > migrations.length) {
      return fail('newer_schema', { found: verified.value.schemaVersion, supported: migrations.length })
    }

    try {
      await deps.close?.()
    } catch (error) {
      log('restore.failed', { stage: 'close', message: String(error) })
      return fail('restore_failed', { stage: 'close', reason: reasonOf(error) })
    }

    const pre = preRestorePath(paths, deps.clock)
    const moved: string[] = []
    let swapped = false
    let stage: 'swap' | 'migrate' | 'check' = 'swap'
    let report: StartupReport
    try {
      const handle = await open(staged, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await moveDbFiles(paths.dbFile, pre, moved)
      log('restore.current_moved', { to: moved.includes('') ? pre : null, moved })
      await renameWithRetry(staged, paths.dbFile)
      swapped = true
      await fsyncDir(paths.db)
      stage = 'migrate'
      const db = openDatabase(paths.dbFile)
      try {
        migrate(db)
      } finally {
        db.close()
      }
      stage = 'check'
      report = startupCheck({ paths, clock: deps.clock, unclean: false, log })
    } catch (error) {
      log('restore.failed', { stage, message: String(error) })
      try {
        if (swapped) await moveDbFiles(paths.dbFile, join(paths.db, `restore-failed-${newId()}.db`))
        for (const s of moved) await renameWithRetry(`${pre}${s}`, `${paths.dbFile}${s}`)
      } catch (rollbackError) {
        log('restore.rollback_failed', { message: String(rollbackError), preRestore: pre })
      }
      return fail('restore_failed', { stage, reason: reasonOf(error) })
    }

    const preRestoreFile = moved.includes('') ? pre : null
    log('restore.done', { file: entry.file, state: report.state })
    return { ok: true, value: { preRestoreFile, report } }
  } finally {
    await removeDbFiles(staged)
  }
}
