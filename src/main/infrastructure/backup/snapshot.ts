import BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { z } from 'zod'
import { newId } from '@shared/ids'
import type { AppError, Result } from '@shared/result'
import type { Database } from '../db/connection'
import { readJsonSafe } from '../fs/atomic'

/** The tables whose row counts a manifest records and a verification compares. */
export const COUNTED_TABLES = ['tickets', 'orders', 'order_lines', 'products', 'users', 'z_reports'] as const

export const BACKUP_KINDS = ['live', 'full', 'pre-change', 'manual'] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/** `<file>.json` next to every `.atlasbak`. `sha256` is over the `.atlasbak` bytes (the gzip). */
export const ManifestSchema = z.object({
  format: z.literal('atlasbak'),
  schemaVersion: z.number().int().nonnegative(),
  appVersion: z.string(),
  /** Empty when the backup was taken before `installation.json` existed. */
  installationId: z.string(),
  createdAt: z.string().min(1),
  kind: z.enum(BACKUP_KINDS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.record(z.string(), z.number().int().nonnegative())
})
export type Manifest = z.infer<typeof ManifestSchema>

export interface SnapshotMeta {
  kind: BackupKind
  appVersion: string
  installationId: string
  createdAt: Date
}

export interface Snapshot {
  /** `<tmpDir>/<id>.atlasbak`; its manifest is `<file>.json`. */
  file: string
  sha256: string
  bytes: number
  counts: Record<string, number>
  manifest: Manifest
}

export const manifestPath = (file: string): string => `${file}.json`

const appError = (code: string, params?: Record<string, unknown>): AppError => ({
  code,
  messageKey: `errors.${code}`,
  ...(params ? { params } : {})
})

/** Removes a database file and whatever SQLite may have left next to it. Never throws. */
export async function removeDbFiles(file: string): Promise<void> {
  await Promise.all(['', '-wal', '-shm', '-journal'].map((s) => rm(`${file}${s}`, { force: true }).catch(() => {})))
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

interface Inspection {
  schemaVersion: number
  counts: Record<string, number>
}

/**
 * Opens a standalone copy, makes it a single self-contained file (`journal_mode=DELETE`: the
 * backup API copies the source's WAL flag into the header), checks it and reads its counts.
 * Throws `backup_corrupt` when `integrity_check` is not clean.
 */
function inspectCopy(file: string, readonly: boolean): Inspection {
  const db = new BetterSqlite3(file, { readonly, fileMustExist: true })
  try {
    if (!readonly) db.pragma('journal_mode = DELETE')
    const check = (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check)
    if (check.length !== 1 || check[0] !== 'ok') {
      throw Object.assign(new Error('integrity_check failed'), { appError: appError('backup_corrupt', { problems: check.slice(0, 5) }) })
    }
    const counts: Record<string, number> = {}
    for (const table of COUNTED_TABLES) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    }
    return { schemaVersion: db.pragma('user_version', { simple: true }) as number, counts }
  } finally {
    db.close()
  }
}

/**
 * Takes a consistent copy of the live database with SQLite's online backup API (asynchronous: it
 * copies in steps and does not block the till), checks it (`integrity_check`), reads the schema
 * version and row counts from the copy itself (a ticket committed meanwhile is either wholly in
 * it or not), gzips it to `<tmpDir>/<id>.atlasbak` and writes the manifest `<file>.json`.
 * The raw copy is always removed. Encryption, when it comes, is one more stage in the gzip
 * pipeline, with a manifest field naming it.
 */
export async function createSnapshot(db: Database, tmpDir: string, meta: SnapshotMeta): Promise<Snapshot> {
  await mkdir(tmpDir, { recursive: true })
  const id = newId()
  const raw = join(tmpDir, `${id}.db`)
  const file = join(tmpDir, `${id}.atlasbak`)
  try {
    await db.backup(raw)
    const { schemaVersion, counts } = inspectCopy(raw, false)
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(file))
    const sha256 = await sha256File(file)
    const { size: bytes } = await stat(file)
    const manifest: Manifest = {
      format: 'atlasbak',
      schemaVersion,
      appVersion: meta.appVersion,
      installationId: meta.installationId,
      createdAt: meta.createdAt.toISOString(),
      kind: meta.kind,
      sha256,
      counts
    }
    await writeFile(manifestPath(file), `${JSON.stringify(manifest, null, 2)}\n`)
    return { file, sha256, bytes, counts, manifest }
  } catch (error) {
    await Promise.all([rm(file, { force: true }), rm(manifestPath(file), { force: true })]).catch(() => {})
    throw error
  } finally {
    await removeDbFiles(raw)
  }
}

/**
 * Checks a backup against its manifest: the manifest parses, the archive's SHA-256 matches, it
 * gunzips into a database that passes `integrity_check`, and its schema version and row counts are
 * the manifest's. On success the database is left at `expandTo`, for a restore to move into place;
 * on failure nothing is left there. Never throws.
 */
export async function expandSnapshot(file: string, expandTo: string): Promise<Result<Manifest>> {
  const manifest = readJsonSafe(manifestPath(file), ManifestSchema)
  if (!manifest) return { ok: false, error: appError('backup_manifest_invalid', { file: basename(file) }) }
  try {
    if ((await sha256File(file)) !== manifest.sha256) {
      return { ok: false, error: appError('backup_checksum_mismatch', { file: basename(file) }) }
    }
    try {
      await pipeline(createReadStream(file), createGunzip(), createWriteStream(expandTo))
    } catch {
      await removeDbFiles(expandTo)
      return { ok: false, error: appError('backup_corrupt', { file: basename(file) }) }
    }
    const found = inspectCopy(expandTo, true)
    const countsMatch =
      Object.keys(manifest.counts).length === COUNTED_TABLES.length &&
      COUNTED_TABLES.every((t) => manifest.counts[t] === found.counts[t])
    if (found.schemaVersion !== manifest.schemaVersion || !countsMatch) {
      await removeDbFiles(expandTo)
      return {
        ok: false,
        error: appError('backup_counts_mismatch', { file: basename(file), expected: manifest.counts, found: found.counts })
      }
    }
    return { ok: true, value: manifest }
  } catch (error) {
    await removeDbFiles(expandTo)
    const known = (error as { appError?: AppError } | null)?.appError
    return { ok: false, error: known ?? appError('backup_corrupt', { file: basename(file), reason: String(error) }) }
  }
}

/** `expandSnapshot` into a scratch file under `tmpDir` that is always removed. */
export async function verifySnapshot(file: string, tmpDir: string = tmpdir()): Promise<Result<Manifest>> {
  await mkdir(tmpDir, { recursive: true })
  const scratch = join(tmpDir, `verify-${newId()}.db`)
  try {
    return await expandSnapshot(file, scratch)
  } finally {
    await removeDbFiles(scratch)
  }
}
