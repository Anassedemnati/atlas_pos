import { app, type BrowserWindow } from 'electron'

const BOOT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 50

interface RendererProbe {
  title: string
  rootText: string
  bridge: string
}

const PROBE_SCRIPT = `({
  title: document.title,
  rootText: document.getElementById('root')?.textContent ?? '',
  bridge: typeof window.atlas
})`

/**
 * Non-interactive launch check, enabled with ATLAS_EXIT_AFTER_BOOT=1.
 * Waits until the renderer has painted "Atlas POS" and the preload bridge exists,
 * then prints ATLAS_BOOT_OK and quits. On failure it prints ATLAS_BOOT_FAIL and exits 1.
 */
export function runBootCheck(window: BrowserWindow): void {
  const fail = (reason: string): void => {
    process.stdout.write(`ATLAS_BOOT_FAIL ${reason}\n`)
    app.exit(1)
  }
  const deadline = Date.now() + BOOT_TIMEOUT_MS

  const probe = async (): Promise<void> => {
    try {
      const result = (await window.webContents.executeJavaScript(PROBE_SCRIPT)) as RendererProbe
      if (result.rootText.includes('Atlas POS') && result.bridge === 'object') {
        process.stdout.write('ATLAS_BOOT_OK\n')
        app.quit()
        return
      }
    } catch (error) {
      if (Date.now() >= deadline) return fail(`probe error: ${String(error)}`)
    }
    if (Date.now() >= deadline) return fail('timeout waiting for the renderer and preload bridge')
    setTimeout(() => void probe(), POLL_INTERVAL_MS)
  }

  window.webContents.once('did-fail-load', (_event, code, description) =>
    fail(`load failed ${code} ${description}`)
  )
  window.webContents.once('did-finish-load', () => void probe())
}
