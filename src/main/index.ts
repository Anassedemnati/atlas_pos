// Composition root: the application's life from launch to quit. The business lives in the use cases;
// this file only puts the pieces together in the right order.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createEventBus } from './application/events'
import { runBootCheck } from './boot-check'
import { createRuntime, type Runtime } from './composition/runtime'
import type { Services } from './composition/services'
import { createSetupService } from './application/usecases/setup'
import { sweepFinishedSetup } from './application/usecases/setup/draft-store'
import { createElectronHtmlPrinter } from './infrastructure/printing/electron/os-print'
import { renderHtmlToBitmap } from './infrastructure/printing/electron/render-html-to-bitmap'
import { forwardEvents } from './interfaces/ipc/events'
import { register } from './interfaces/ipc/register'
import { createSessionStore, type SessionStore } from './interfaces/ipc/session-store'
import { setAutostart } from './lifecycle/autostart'
import { startBackoffice } from './lifecycle/backoffice'
import { setDurableLogDir, writeDurable } from './lifecycle/fatal'
import { acquireInstanceLock } from './lifecycle/instance-lock'
import { handleMediaProtocol, registerMediaScheme } from './lifecycle/media-protocol'
import { acquireRunningLock, type RunningLock } from './lifecycle/running-lock'
import { createShellPorts, sendToWindows, type AppWindows } from './lifecycle/shell-ports'
import { createCustomerDisplay, createTillWindow, loadRoute, type WindowConfig } from './lifecycle/windows'
import { createConsoleLogger, createFileLogger, describeError, type Logger } from './logger'
import { ensureDataLayout, resolveDataDir, resolveTemplateMediaDir } from './paths'
import { RESTART_NORMALLY_EXIT_CODE } from './supervisor-policy'

const here = dirname(fileURLToPath(import.meta.url))
const dev = !app.isPackaged
const exitAfterBoot = process.env['ATLAS_EXIT_AFTER_BOOT'] === '1'
const isChild = process.argv.includes('--child')
const safeMode = process.argv.includes('--safe-mode')

// Before the app is ready, or Chromium ignores it.
registerMediaScheme()

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
/** Set by `app.quit()` (quit to desktop, OS shutdown): only then may a kiosk till window close. */
let quitRequested = false
/** The code the process exits with after a clean quit: 0, or "start me again normally" for the watchdog. */
let exitCode = 0
/** `start()` has finished: a failure after this point no longer means the application cannot start. */
let started = false
/** Crashes of the till renderer: reloaded, unless it keeps crashing. */
const rendererCrashes: number[] = []
const RENDERER_CRASH_LIMIT = 3
const RENDERER_CRASH_WINDOW_MS = 60_000
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

/**
 * The end of a run that cannot go on: the reason is written synchronously (the asynchronous log may not
 * even be open yet), then the process exits with 1, which the watchdog counts as a crash. Never throws.
 */
function die(event: string, error: unknown): void {
  writeDurable(event, describeError(error))
  try {
    log.error(event, describeError(error))
    log.flush()
  } catch {
    // The durable line is written already.
  }
  try {
    if (exitAfterBoot) process.stdout.write(`ATLAS_BOOT_FAIL ${event}: ${String(error)}\n`)
  } finally {
    app.exit(1)
  }
}

/** Runs a step the till can live without (customer display, autostart, back office): a failure is logged. */
function optional(step: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    log.error('app.optional_step_failed', { step, ...describeError(error) })
  }
}

/** Quits so that the watchdog starts the application again normally; in development, relaunches it. */
function restartNormally(): void {
  if (isChild) exitCode = RESTART_NORMALLY_EXIT_CODE
  else app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--safe-mode') })
  app.quit()
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

/**
 * Kiosk mode does not stop Alt+F4, and a closed till quits with code 0, which the watchdog takes as "stop for
 * good": only an authorized quit (the technician, the OS ending the session) closes the till. Once is enough.
 */
let kioskGuarded = false
function guardKiosk(window: BrowserWindow): void {
  if (kioskGuarded || dev) return
  kioskGuarded = true
  window.on('close', (event) => {
    if (!quitRequested) event.preventDefault()
  })
  window.on('session-end', () => (quitRequested = true))
}

/** What depends on the settings of the open database and is not needed to sell: customer display, back office, auto-start. */
function startServiceDependents(current: Runtime, services: Services, sessions: SessionStore): void {
  if (!safeMode) {
    optional('customer-display', () => {
      if (display || !services.settings.get('display.customerEnabled')) return
      display = createCustomerDisplay(windowConfig)
      if (display) {
        trackSessions(display, sessions)
        display.on('closed', () => (display = null))
      }
    })
  }
  optional('backoffice', () => {
    if (!stopBackoffice && services.settings.get('backoffice.enabled')) stopBackoffice = startBackoffice({ runtime: current, log })
  })
  optional('autostart', () => setAutostart(services.settings.get('autostart.enabled')))
}

/** The setup has just finished (or a backup was restored onto a new installation): the till window is already open, now it can become a kiosk. */
function applyKiosk(services: Services): void {
  if (!till || till.isDestroyed() || safeMode || dev || !services.settings.get('kiosk.enabled')) return
  till.setKiosk(true)
  till.setFullScreen(true)
  guardKiosk(till)
}

async function start(): Promise<void> {
  // 1. Paths and the log file (the single-instance lock is already held).
  const dataDir = resolveDataDir(process.env, process.platform)
  setDurableLogDir(join(dataDir, 'logs'))
  const paths = ensureDataLayout(dataDir)
  log = createFileLogger(paths.logs, dev && !exitAfterBoot)
  log.info('app.start', { version: app.getVersion(), packaged: app.isPackaged, safeMode, dataDir: paths.root })
  // Product photos and the logo: only `<data dir>/media` is reachable through `atlas-media://local/...`.
  optional('media-protocol', () => handleMediaProtocol(paths.media))
  // 2. The running lock: left behind, it says the previous run did not quit cleanly.
  runningLock = acquireRunningLock(paths)

  // 3. The start-up check, then the database and the services for `ok` and `recovered` only.
  const bus = createEventBus((error, event) => log.error('event.handler_failed', { type: event.type, ...describeError(error) }))
  const clock = { now: () => new Date() }
  const htmlPrinter = createElectronHtmlPrinter()
  const current = createRuntime({
    paths,
    clock,
    bus,
    log,
    appVersion: app.getVersion(),
    rasterize: renderHtmlToBitmap,
    htmlPrinter,
    unclean: runningLock.wasUnclean,
    safeMode
  })
  runtime = current
  current.boot()
  const status = current.status()
  const services = current.services()

  // 4. The IPC contract, sessions per window, events to the windows.
  const sessions = createSessionStore()
  const shell = createShellPorts({
    windows,
    config: windowConfig,
    appVersion: app.getVersion(),
    log,
    quit: () => app.quit(),
    restartNormally,
    afterSetup() {
      const opened = current.services()
      if (!opened) return
      optional('kiosk', () => applyKiosk(opened))
      startServiceDependents(current, opened, sessions)
    }
  })
  // The setup wizard's back end: used only while no installation exists (the IPC layer enforces it).
  const setup = createSetupService({
    paths,
    clock,
    bus,
    log,
    appVersion: app.getVersion(),
    rasterize: renderHtmlToBitmap,
    htmlPrinter,
    setAutostart,
    restore: (file) => current.restore(file),
    templateMediaDir: resolveTemplateMediaDir(app.isPackaged, app.getAppPath(), process.resourcesPath)
  })
  register(ipcMain, { paths, runtime: current, setup, shell, log, clock, durableLog: writeDurable }, sessions)
  forwardEvents(bus, (event) => sendToWindows(windows, event))

  // 5. The till window, on the route the start-up decided. No kiosk while no database is open (setup,
  // recovery): there is no technician code yet, or none readable, to leave it with.
  const kiosk = !safeMode && services !== null && services.settings.get('kiosk.enabled')
  till = createTillWindow(windowConfig, kiosk)
  trackSessions(till, sessions)
  if (kiosk) guardKiosk(till)
  till.on('closed', () => {
    till = null
    app.quit()
  })
  // A crashed renderer comes back on the same route rather than leaving a blank till; one that keeps
  // crashing (3 times within a minute) ends the run, for the watchdog to take over.
  till.webContents.on('render-process-gone', (_event, details) => {
    log.error('till.renderer_gone', { reason: details.reason })
    const now = Date.now()
    rendererCrashes.push(now)
    while (rendererCrashes.length > 0 && now - (rendererCrashes[0] ?? now) > RENDERER_CRASH_WINDOW_MS) rendererCrashes.shift()
    if (rendererCrashes.length >= RENDERER_CRASH_LIMIT) return die('till.renderer_crash_loop', new Error(details.reason))
    if (till && !till.isDestroyed()) {
      loadRoute(till, current.status().route, windowConfig).catch((error: unknown) =>
        log.error('till.reload_failed', describeError(error))
      )
    }
  })
  if (exitAfterBoot) runBootCheck(till)
  log.info('app.route', { route: status.route })
  await loadRoute(till, status.route, windowConfig)

  // 6. Background work, only now: printing renders in hidden windows, which must never be the last ones.
  // None of it is needed to sell: a failure is logged and the till carries on.
  optional('background', () => current.startBackground())
  if (services) {
    optional('setup-sweep', () => sweepFinishedSetup(paths))
    startServiceDependents(current, services, sessions)
  }
  // Whichever database is open (it may be created by the setup, or replaced by a restore).
  bus.subscribe('settings.changed', ({ keys }) => {
    const now = current.services()
    if (now && keys.includes('autostart.enabled')) optional('autostart', () => setAutostart(now.settings.get('autostart.enabled')))
  })
}

/** Stops the services, closes the database and releases the running lock (a clean quit). */
async function shutdown(): Promise<void> {
  try {
    await stopBackoffice?.()
    await runtime?.shutdown()
  } catch (error) {
    log.error('app.shutdown_failed', describeError(error))
  }
  try {
    runningLock?.release()
  } catch (error) {
    // The next start will report an unclean shutdown: harmless, it only checks more.
    log.error('app.lock_release_failed', describeError(error))
  }
  log.info('app.quit', { exitCode })
  log.flush()
}

if (!dev && !isChild && !exitAfterBoot) {
  relaunchUnderSupervisor()
  app.exit(0)
} else if (!acquireInstanceLock(app, () => (till?.show(), till?.focus()))) {
  // Another copy is running: it shows its till window.
  app.exit(0)
} else {
  // Anything thrown outside a handler: written down, then a crash for the watchdog to restart.
  process.on('uncaughtException', (error) => die('app.uncaught_exception', error))
  process.on('unhandledRejection', (reason) => {
    if (!started) return die('app.unhandled_rejection', reason)
    log.error('app.unhandled_rejection', describeError(reason))
  })
  app.on('before-quit', () => (quitRequested = true))
  app.on('window-all-closed', () => {
    // Hidden printing windows come and go: only the till window's end quits.
    if (!till) app.quit()
  })
  app.on('will-quit', (event) => {
    if (cleanedUp) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void shutdown()
      .catch(() => {})
      .finally(() => {
        cleanedUp = true
        app.exit(exitCode)
      })
  })
  app
    .whenReady()
    .then(start)
    .then(() => (started = true))
    .catch((error: unknown) => {
      try {
        die('app.start_failed', error)
      } finally {
        app.exit(1)
      }
    })
}
