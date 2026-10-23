import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ZodType } from 'zod'

/** Makes the directory entry itself (a created or renamed file) durable. Not supported on Windows. */
function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** On Windows an antivirus scan or the search indexer can hold the target for a moment, and the rename fails meanwhile. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_TRIES = 5
const RENAME_RETRY_DELAY_MS = 50

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** `renameSync`, retried a few times on Windows when the target is transiently locked. Other errors are not retried. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= RENAME_TRIES || !RENAME_RETRY_CODES.has(code)) throw error
      sleepSync(RENAME_RETRY_DELAY_MS)
    }
  }
}

/**
 * Replaces `path` with `data` so that a reader (or the next start after a power cut) sees either
 * the old content or the new one, never a torn file: write `<path>.tmp`, fsync it, rename it over
 * `path` (on Windows retried up to 5 times, 50 ms apart, while the target is locked), fsync the
 * directory.
 * - If anything fails before the rename completes, the temp file is removed (best effort, a failed
 *   cleanup never replaces the original error) and `path` is untouched. After a real crash a stale
 *   `<path>.tmp` may remain; the next write overwrites it.
 * - If the directory fsync fails, the rename has already happened: `path` holds the new content but
 *   the call throws, because the rename is not known to be durable yet. A caller that retries
 *   writes the same content again.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, data) // loops until every byte is written (writeSync may write less)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWithRetry(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Keep the original failure: a leftover temp file is harmless, the next write replaces it.
    }
    throw error
  }
  fsyncDirectory(dirname(path))
}

/**
 * Reads a JSON file and validates it. Never throws: a missing, unreadable, malformed or
 * schema-violating file gives `null`, and the caller decides what that means.
 */
export function readJsonSafe<T>(path: string, schema: ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
