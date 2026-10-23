// Composition root: the application's life from launch to quit. The business lives in the use cases;
// this file only puts the pieces together in the right order.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createEventBus } from './application/events'
import { runBootCheck } from './boot-check'
import { createRuntime, type Runtime } from './composition/runtime'
import { defaultOf } from './domain/config/settings-registry'
import { createElectronHtmlPrinter } from './infrastructure/printing/electron/os-print'
import { renderHtmlToBitmap } from './infrastructure/printing/electron/render-html-to-bitmap'
import { forwardEvents } from './interfaces/ipc/events'
import { register } from './interfaces/ipc/register'
import { createSessionStore, type SessionStore } from './interfaces/ipc/session-store'
import { setAutostart } from './lifecycle/autostart'
import { startBackoffice } from './lifecycle/backoffice'
import { acquireInstanceLock } from './lifecycle/instance-lock'
import { acquireRunningLock, type RunningLock } from './lifecycle/running-lock'
import { createShellPorts, sendToWindows, type AppWindows } from './lifecycle/shell-ports'
import { createCustomerDisplay, createTillWindow, loadRoute, type WindowConfig } from './lifecycle/windows'
import { createConsoleLogger, createFileLogger, describeError, type Logger } from './logger'
import { ensureDataLayout, resolveDataDir } from './paths'

const here = dirname(fileURLToPath(import.meta.url))
const dev = !app.isPackaged
const exitAfterBoot = process.env['ATLAS_EXIT_AFTER_BOOT'] === '1'
const isChild = process.argv.includes('--child')
const safeMode = process.argv.includes('--safe-mode')

const windowConfig: WindowConfig = {
  preload: join(here, '../preload/index.cjs'),
  indexFile: join(here, '../renderer/index.html'),
  // The dev server only in development: a packaged app never loads a URL from the environment.
  devServerUrl: dev ? (process.env['ELECTRON_RENDERER_URL'] ?? null) : null,
  dev,
  show: !exitAfterBoot
}

let log: Logger = createConsoleLogger()
let till: BrowserWindow | null = null
let display: BrowserWindow | null = null
let runtime: Runtime | null = null
let runningLock: RunningLock | null = null
let stopBackoffice: (() => Promise<void>) | null = null
let quitting = false
let cleanedUp = false
const windows: AppWindows = { till: () => till, display: () => display }

/**
 * Production starts the watchdog first: this launch starts it (detached, as plain Node) and quits; the
 * watchdog then starts the application with `--child`. Decided before the single-instance lock, so a
 * launcher never holds the lock its child needs.
 */
function relaunchUnderSupervisor(): void {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  spawn(process.execPath, [join(here, 'supervisor.js'), ...process.argv.slice(1)], { env, detached: true, stdio: 'ignore' }).unref()
}

/** The window's session ends with its document: closed, crashed, or loaded anew (not a hash route change). */
function trackSessions(window: BrowserWindow, sessions: SessionStore): void {
  const id = window.webContents.id
  window.webContents.on('destroyed', () => sessions.forget(id))
  window.webContents.on('render-process-gone', () => sessions.forget(id))
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) sessions.forget(id)
  })
}

async function start(): Promise<void> {
  // 1. Paths and the log file (the single-instance lock is already held).
  const paths = ensureDataLayout(resolveDataDir(process.env, process.platform))
  log = createFileLogger(paths.logs, dev && !exitAfterBoot)
  log.info('app.start', { version: app.getVersion(), packaged: app.isPackaged, safeMode, dataDir: paths.root })
  // 2. The running lock: left behind, it says the previous run did not quit cleanly.
  runningLock = acquireRunningLock(paths)

  // 3. The start-up check, then the database and the services for `ok` and `recovered` only.
  const bus = createEventBus((error, event) => log.error('event.handler_failed', { type: event.type, ...describeError(error) }))
  const current = createRuntime({
    paths,
    clock: { now: () => new Date() },
    bus,
    log,
    appVersion: app.getVersion(),
    rasterize: renderHtmlToBitmap,
    htmlPrinter: createElectronHtmlPrinter(),
    unclean: runningLock.wasUnclean,
    safeMode
  })
  runtime = current
  current.boot()
  const status = current.status()
  const services = current.services()

  // 4. The IPC contract, sessions per window, events to the windows.
  const sessions = createSessionStore()
  const shell = createShellPorts({ windows, config: windowConfig, appVersion: app.getVersion(), quit: () => app.quit() })
  register(ipcMain, { paths, runtime: current, shell, log }, sessions)
  forwardEvents(bus, (event) => sendToWindows(windows, event))

  // 5. The till window, on the route the start-up decided.
  const kiosk = !safeMode && (services ? services.settings.get('kiosk.enabled') : defaultOf('kiosk.enabled'))
  till = createTillWindow(windowConfig, kiosk)
  trackSessions(till, sessions)
  till.on('closed', () => {
    till = null
    app.quit()
  })
  // A crashed renderer comes back on the same route rather than leaving a blank till.
  till.webContents.on('render-process-gone', (_event, details) => {
    log.error('till.renderer_gone', { reason: details.reason })
    if (till && !till.isDestroyed()) void loadRoute(till, current.status().route, windowConfig)
  })
  if (exitAfterBoot) runBootCheck(till)
  log.info('app.route', { route: status.route })
  await loadRoute(till, status.route, windowConfig)

  // 6. Background work, only now: printing renders in hidden windows, which must never be the last ones.
  current.startBackground()
  if (services && !safeMode && services.settings.get('display.customerEnabled')) {
    display = createCustomerDisplay(windowConfig)
    if (display) {
      trackSessions(display, sessions)
      display.on('closed', () => (display = null))
    }
  }
  if (services && services.settings.get('backoffice.enabled')) stopBackoffice = startBackoffice({ runtime: current, log })
  if (services) {
    setAutostart(services.settings.get('autostart.enabled'))
    bus.subscribe('settings.changed', ({ keys }) => {
      const now = current.services()
      if (now && keys.includes('autostart.enabled')) setAutostart(now.settings.get('autostart.enabled'))
    })
  }
}

/** Stops the services, closes the database and releases the running lock (a clean quit). */
async function shutdown(): Promise<void> {
  try {
    await stopBackoffice?.()
    await runtime?.shutdown()
  } catch (error) {
    log.error('app.shutdown_failed', describeError(error))
  }
  runningLock?.release()
  log.info('app.quit')
  log.flush()
}

if (!dev && !isChild && !exitAfterBoot) {
  relaunchUnderSupervisor()
  app.exit(0)
} else if (!acquireInstanceLock(app, () => (till?.show(), till?.focus()))) {
  // Another copy is running: it shows its till window.
  app.exit(0)
} else {
  app.on('window-all-closed', () => {
    // Hidden printing windows come and go: only the till window's end quits.
    if (!till) app.quit()
  })
  app.on('will-quit', (event) => {
    if (cleanedUp) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void shutdown().finally(() => {
      cleanedUp = true
      app.exit(0)
    })
  })
  app.whenReady().then(start).catch((error: unknown) => {
    log.error('app.start_failed', describeError(error))
    log.flush()
    if (exitAfterBoot) process.stdout.write(`ATLAS_BOOT_FAIL start: ${String(error)}\n`)
    app.exit(1)
  })
}
