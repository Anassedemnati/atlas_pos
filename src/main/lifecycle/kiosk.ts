import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

/**
 * The till fills the screen and cannot be left (no frame, no task switch in the window) when the
 * `kiosk.enabled` setting is on, in production only: development keeps a normal window. A technician
 * leaves with `app.quitToDesktop`.
 */
export function kioskOptions(enabled: boolean, dev: boolean): Pick<BrowserWindowConstructorOptions, 'kiosk' | 'fullscreen'> {
  const on = enabled && !dev
  return { kiosk: on, fullscreen: on }
}

/**
 * Production hardening of an application window: no menu, no developer tools, no reload or zoom
 * shortcuts. In kiosk mode a reload would only show the same screen, but a zoom would break the layout
 * of the till until someone found the keys again.
 */
export function lockDown(window: BrowserWindow): void {
  window.setMenu(null)
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const modifier = input.control || input.meta
    const blocked =
      key === 'f12' ||
      key === 'f5' ||
      (modifier && ['r', '+', '-', '=', '0'].includes(key)) ||
      (modifier && input.shift && key === 'i')
    if (blocked) event.preventDefault()
  })
}
