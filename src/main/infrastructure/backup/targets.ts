import { randomBytes, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Result } from '@shared/result'
import type { Database } from '../db/connection'
import { BACKUP_DIR, usbScan } from './usb-scan'

export type TargetRole = 'disk' | 'usb' | 'nas'

/** A backup destination. Its root holds `AtlasBackup/{live,full}/`. */
export interface BackupTarget {
  id: string
  role: TargetRole
  /** What to show the user: the label, else the path or the USB key. */
  describe(): string
  /** Where the destination is right now, or null when it is not available (unplugged, unmounted, read-only). */
  resolveRoot(): Promise<string | null>
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
 * A disk or NAS folder: available when the configured path is a writable directory. A missing path
 * is never created, so an unmounted NAS share stays "unavailable" instead of silently becoming a
 * folder on the local disk.
 */
export function folderTarget(def: { id: string; role: 'disk' | 'nas'; path: string; label?: string }): BackupTarget {
  return {
    id: def.id,
    role: def.role,
    describe: () => def.label || def.path,
    resolveRoot: async () => ((await isWritableDir(def.path)) ? def.path : null)
  }
}

/** A USB drive, found wherever it is mounted by its `AtlasBackup/.atlas-target` marker. */
export function usbTarget(
  def: { id: string; targetKey: string; label?: string },
  scan: (targetKey: string) => Promise<string | null> = (key) => usbScan(key)
): BackupTarget {
  return {
    id: def.id,
    role: 'usb',
    describe: () => def.label || `USB ${def.targetKey}`,
    resolveRoot: async () => {
      const root = await scan(def.targetKey)
      return root && (await isWritableDir(root)) ? root : null
    }
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
      ? usbTarget({ id: row.id, targetKey: row.targetKey, label: row.label }, scan)
      : folderTarget({ id: row.id, role: row.role, path: row.path, label: row.label })
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
 * Checks a destination end to end: writes a 1 MB probe into `AtlasBackup/`, reads it back,
 * compares, deletes it, and reports the free space. Never throws.
 */
export async function testTarget(target: BackupTarget): Promise<Result<{ writableBytes: number }>> {
  const fail = (code: string, params: Record<string, unknown>): Result<never> => ({
    ok: false,
    error: { code, messageKey: `errors.${code}`, params }
  })
  const root = await target.resolveRoot()
  if (!root) return fail('backup_target_unavailable', { targetId: target.id })
  let probe: string | null = null
  try {
    const dir = await ensureSubdir(root, BACKUP_DIR)
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
