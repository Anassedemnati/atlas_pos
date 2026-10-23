import { BrowserWindow, screen } from 'electron'
import { kioskOptions, lockDown } from './kiosk'

/** Where the renderer comes from and how the application windows are built. */
export interface WindowConfig {
  preload: string
  /** `out/renderer/index.html`. */
  indexFile: string
  /** The Vite dev server (development only), or null. */
  devServerUrl: string | null
  /** Development (unpackaged): no kiosk, no lock-down. */
  dev: boolean
  /** Hidden windows (the non-interactive boot check). */
  show: boolean
}

const BACKGROUND = '#F4F5F7'

const webPreferences = (config: WindowConfig): Electron.WebPreferences => ({
  preload: config.preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
})

/** Loads the renderer on a hash route (`#/login`). */
export function loadRoute(window: BrowserWindow, route: string, config: WindowConfig): Promise<void> {
  const hash = route.replace(/^#/, '')
  return config.devServerUrl ? window.loadURL(`${config.devServerUrl}#${hash}`) : window.loadFile(config.indexFile, { hash })
}

/** The renderer stays on its own page: no navigation away, no new window. */
function confine(window: BrowserWindow, config: WindowConfig): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = config.devServerUrl ? url.startsWith(config.devServerUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })
  if (!config.dev) lockDown(window)
}

/** The till: kiosk and full screen when `kiosk.enabled` (production only). */
export function createTillWindow(config: WindowConfig, kiosk: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Atlas POS',
    backgroundColor: BACKGROUND,
    show: config.show,
    ...kioskOptions(kiosk, config.dev),
    webPreferences: webPreferences(config)
  })
  confine(window, config)
  return window
}

/**
 * The customer display (`#/display`), full screen on the second screen. Null when there is no second
 * screen: the till works without it.
 */
export function createCustomerDisplay(config: WindowConfig): BrowserWindow | null {
  const display = screen.getAllDisplays()[1]
  if (!display) return null
  const { x, y, width, height } = display.bounds
  const window = new BrowserWindow({
    x,
    y,
    width,
    height,
    title: 'Atlas POS',
    backgroundColor: BACKGROUND,
    show: config.show,
    frame: false,
    fullscreen: !config.dev,
    focusable: false,
    webPreferences: webPreferences(config)
  })
  confine(window, config)
  void loadRoute(window, '#/display', config)
  return window
}
