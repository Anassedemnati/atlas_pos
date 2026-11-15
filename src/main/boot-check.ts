import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { openDatabase } from './infrastructure/db/connection'

const BOOT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 50
/** `ERR_ABORTED`: a load replaced by another one (a hash route change), not a failure. */
const ERR_ABORTED = -3

interface RendererProbe {
  rootText: string
  bridge: string
  hash: string
  report: { ok: boolean; value?: { route?: string } } | null
}

// Calls the contract over the real preload and IPC, so the check covers the whole bridge.
const PROBE_SCRIPT = `(async () => ({
  rootText: document.getElementById('root')?.textContent ?? '',
  bridge: typeof window.atlas,
  hash: location.hash,
  report: typeof window.atlas?.invoke === 'function' ? await window.atlas.invoke('app.startupReport', {}) : null
}))()`

/** better-sqlite3's native module loads inside Electron: opens, queries and closes a temporary database. */
function probeSqlite(): string {
  const file = join(tmpdir(), `atlas-boot-check-${process.pid}.db`)
  const db = openDatabase(file)
  try {
    return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
  } finally {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
  }
}

/**
 * Non-interactive launch check, enabled with ATLAS_EXIT_AFTER_BOOT=1. Proves that SQLite loads, then
 * waits until the renderer has painted "Atlas POS", the preload bridge exists and `app.startupReport`
 * answers with the route the window is on. Prints ATLAS_BOOT_SQLITE, ATLAS_BOOT_ROUTE and ATLAS_BOOT_OK,
 * then quits; on failure prints ATLAS_BOOT_FAIL and exits 1.
 */
export function runBootCheck(window: BrowserWindow): void {
  let done = false
  const fail = (reason: string): void => {
    if (done) return
    done = true
    process.stdout.write(`ATLAS_BOOT_FAIL ${reason}\n`)
    app.exit(1)
  }
  try {
    process.stdout.write(`ATLAS_BOOT_SQLITE ${probeSqlite()}\n`)
  } catch (error) {
    return fail(`sqlite: ${String(error)}`)
  }
  const deadline = Date.now() + BOOT_TIMEOUT_MS

  const probe = async (): Promise<void> => {
    if (done) return
    try {
      const result = (await window.webContents.executeJavaScript(PROBE_SCRIPT)) as RendererProbe
      if (result.rootText.includes('Atlas POS') && result.bridge === 'object' && result.report?.ok) {
        if (result.report.value?.route !== result.hash) return fail(`route mismatch: ${result.hash} vs ${result.report.value?.route}`)
        done = true
        process.stdout.write(`ATLAS_BOOT_ROUTE ${result.hash}\nATLAS_BOOT_OK\n`)
        app.quit()
        return
      }
    } catch (error) {
      if (Date.now() >= deadline) return fail(`probe error: ${String(error)}`)
    }
    if (Date.now() >= deadline) return fail('timeout waiting for the renderer and preload bridge')
    setTimeout(() => void probe(), POLL_INTERVAL_MS)
  }

  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED) return
    fail(`load failed ${code} ${description}`)
  })
  window.webContents.once('did-finish-load', () => void probe())
}
