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

/**
 * Replaces `path` with `data` so that a reader (or the next start after a power cut) sees either
 * the old content or the new one, never a torn file: write `<path>.tmp`, fsync it, rename it over
 * `path`, fsync the directory. On failure the temp file is removed and `path` is untouched. After
 * a real crash a stale `<path>.tmp` may remain; the next write overwrites it.
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
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
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
