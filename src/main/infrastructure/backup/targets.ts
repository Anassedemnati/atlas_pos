import { randomBytes, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Result } from '@shared/result'
import type { Database } from '../db/connection'
import { BACKUP_DIR, TARGET_MARKER, hasTargetMarker, usbScan } from './usb-scan'

export type TargetRole = 'disk' | 'usb' | 'nas'

/** A backup destination. Its root holds `AtlasBackup/.atlas-target` and `AtlasBackup/{live,full}/`. */
export interface BackupTarget {
  id: string
  role: TargetRole
  /** The content of its `AtlasBackup/.atlas-target` marker. */
  targetKey: string
  /** What to show the user: the label, else the path or the USB key. */
  describe(): string
  /**
   * Where the destination is right now: a writable root whose marker holds `targetKey`. Null when
   * it is not available (unplugged, unmounted, read-only, not marked yet).
   */
  resolveRoot(): Promise<string | null>
  /** The configured path when it exists and is writable, marked or not: where `testTarget` puts the marker. */
  setupRoot(): Promise<string | null>
}

/** True when `dir` exists, is a directory and this process may write into it. */
async function isWritableDir(dir: string): Promise<boolean> {
  try {
    if (!(await stat(dir)).isDirectory()) return false
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A disk or NAS folder: available when the configured path is a writable directory holding the
 * marker with `targetKey`. A missing path is never created, and an unmarked one (an unmounted NAS
 * mount point is an empty local folder) is never written to: both stay "unavailable".
 */
export function folderTarget(def: {
  id: string
  role: 'disk' | 'nas'
  path: string
  targetKey: string
  label?: string
}): BackupTarget {
  const setupRoot = async (): Promise<string | null> => ((await isWritableDir(def.path)) ? def.path : null)
  return {
    id: def.id,
    role: def.role,
    targetKey: def.targetKey,
    describe: () => def.label || def.path,
    resolveRoot: async () => {
      const root = await setupRoot()
      return root && (await hasTargetMarker(root, def.targetKey)) ? root : null
    },
    setupRoot
  }
}

/**
 * A USB drive, found wherever it is mounted by its marker. `path` is where it was mounted when it
 * was configured (only used to mark it).
 */
export function usbTarget(
  def: { id: string; targetKey: string; label?: string; path?: string },
  scan: (targetKey: string) => Promise<string | null> = (key) => usbScan(key)
): BackupTarget {
  return {
    id: def.id,
    role: 'usb',
    targetKey: def.targetKey,
    describe: () => def.label || `USB ${def.targetKey}`,
    resolveRoot: async () => {
      const root = await scan(def.targetKey)
      return root && (await isWritableDir(root)) ? root : null
    },
    setupRoot: async () => (def.path && (await isWritableDir(def.path)) ? def.path : null)
  }
}

/** One target per enabled `backup_destinations` row, in table order. */
export function targetsFromDestinations(
  db: Database,
  scan?: (targetKey: string) => Promise<string | null>
): BackupTarget[] {
  const rows = db
    .prepare('SELECT id, role, path, label, target_key AS targetKey FROM backup_destinations WHERE enabled = 1 ORDER BY rowid')
    .all() as { id: string; role: TargetRole; path: string; label: string; targetKey: string }[]
  return rows.map((row) =>
    row.role === 'usb'
      ? usbTarget({ id: row.id, targetKey: row.targetKey, label: row.label, path: row.path }, scan)
      : folderTarget({ id: row.id, role: row.role, path: row.path, targetKey: row.targetKey, label: row.label })
  )
}

/**
 * Creates `root/<parts...>` one level at a time without ever creating `root` itself: if the drive
 * disappears between `resolveRoot` and here, this fails instead of recreating the mount point on
 * the system disk.
 */
export async function ensureSubdir(root: string, ...parts: string[]): Promise<string> {
  let dir = root
  for (const part of parts) {
    dir = join(dir, part)
    try {
      await mkdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return dir
}

/** On Windows an antivirus scan or the search indexer can hold the target for a moment. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_TRIES = 5
const RENAME_RETRY_DELAY_MS = 50

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= RENAME_TRIES || !RENAME_RETRY_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS))
    }
  }
}

/** Makes a created or renamed entry of `dir` durable (best effort: not supported on Windows or some network shares). */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some filesystems (SMB, FAT on some kernels) refuse a directory fsync; the data itself is synced.
  }
}

/**
 * The asynchronous counterpart of `writeFileAtomic` for copies: copy to `<dest>.tmp`, check its
 * size, fsync it, rename it over `dest` (retried on Windows), fsync the directory. A reader sees
 * the old file or the new one, never a torn one; on failure the temp file is removed and `dest`
 * is untouched. The parent directory must exist.
 */
export async function copyFileAtomic(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`
  try {
    await copyFile(src, tmp)
    const handle = await open(tmp, 'r+')
    try {
      const [copied, original] = await Promise.all([handle.stat(), stat(src)])
      if (copied.size !== original.size) {
        throw Object.assign(new Error(`short copy: ${copied.size} of ${original.size} bytes`), { code: 'ESHORT' })
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, dest)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  await fsyncDir(dirname(dest))
}

const PROBE_BYTES = 1024 * 1024

/**
 * The setup "Tester" button: checks a destination end to end and marks it. When the target is not
 * found by its marker but its configured path exists and is writable, creates `AtlasBackup/` and
 * the marker there (whatever the role). Then writes a 1 MB probe into `AtlasBackup/`, reads it
 * back, compares, deletes it, and reports the free space. Never rejects.
 */
export async function testTarget(target: BackupTarget): Promise<Result<{ writableBytes: number }>> {
  const fail = (code: string, params: Record<string, unknown>): Result<never> => ({
    ok: false,
    error: { code, messageKey: `errors.${code}`, params }
  })
  let probe: string | null = null
  try {
    if (!target.targetKey.trim()) return fail('backup_target_unavailable', { targetId: target.id, reason: 'no_key' })
    let root = await target.resolveRoot()
    if (!root) {
      root = await target.setupRoot()
      if (!root) return fail('backup_target_unavailable', { targetId: target.id })
      await ensureSubdir(root, BACKUP_DIR)
      await writeFile(join(root, BACKUP_DIR, TARGET_MARKER), `${target.targetKey.trim()}\n`, { flush: true })
    }
    const dir = join(root, BACKUP_DIR)
    probe = join(dir, `.probe-${randomBytes(6).toString('hex')}`)
    const data = randomBytes(PROBE_BYTES)
    await writeFile(probe, data, { flush: true })
    const back = await readFile(probe)
    const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    if (digest(back) !== digest(data)) return fail('backup_probe_failed', { targetId: target.id, reason: 'mismatch' })
    const fs = await statfs(root)
    return { ok: true, value: { writableBytes: fs.bavail * fs.bsize } }
  } catch (error) {
    return fail('backup_probe_failed', {
      targetId: target.id,
      reason: (error as NodeJS.ErrnoException).code ?? String(error)
    })
  } finally {
    if (probe) await rm(probe, { force: true }).catch(() => {})
  }
}
