import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let logsDir: string | null = null

/** Where `logs/fatal.log` goes, as soon as the data directory is known (before it is even created). */
export function setDurableLogDir(dir: string): void {
  logsDir = dir
}

/**
 * Appends one JSON line to `logs/fatal.log` synchronously (the system temp directory until the data
 * directory is known, or when it cannot be written). For what must be on disk even if the process dies
 * on the next line: fatal errors, and a restore nobody signed in for. Never throws.
 */
export function writeDurable(event: string, data: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data })}\n`
  for (const dir of [logsDir, tmpdir()]) {
    if (!dir) continue
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'fatal.log'), line)
      return
    } catch {
      // Try the next place.
    }
  }
  try {
    process.stderr.write(line)
  } catch {
    // Nowhere left to write.
  }
}
