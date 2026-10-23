import { BrowserWindow, dialog, screen, webContents, type OpenDialogOptions } from 'electron'
import type { AtlasEvent } from '@shared/dto'
import { EVENT_CHANNEL } from '@shared/ipc/channels'
import { detectHardware } from '../infrastructure/hardware/detect'
import { listSystemPrinters } from '../infrastructure/printing/electron/system-printers'
import type { ShellPorts } from '../interfaces/ipc/context'
import { loadRoute, type WindowConfig } from './windows'

/** The application windows (not the hidden printing helpers). */
export interface AppWindows {
  till(): BrowserWindow | null
  display(): BrowserWindow | null
}

const alive = (window: BrowserWindow | null): window is BrowserWindow => window !== null && !window.isDestroyed()

/** Sends an event to the till and the customer display. */
export function sendToWindows(windows: AppWindows, event: AtlasEvent): void {
  for (const window of [windows.till(), windows.display()]) {
    if (alive(window)) window.webContents.send(EVENT_CHANNEL, event)
  }
}

async function openDialog(windowId: number, options: OpenDialogOptions): Promise<string | null> {
  const contents = webContents.fromId(windowId)
  const owner = contents ? BrowserWindow.fromWebContents(contents) : null
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Electron's side of the IPC handlers: dialogs, hardware, the customer display, reloading the till. */
export function createShellPorts(deps: { windows: AppWindows; config: WindowConfig; appVersion: string; quit: () => void }): ShellPorts {
  const { windows, config } = deps
  return {
    appVersion: deps.appVersion,
    pickFolder: (windowId, title) =>
      openDialog(windowId, { properties: ['openDirectory', 'createDirectory'], ...(title ? { title } : {}) }),
    pickFile: (windowId, { title, extensions }) =>
      openDialog(windowId, {
        properties: ['openFile'],
        ...(title ? { title } : {}),
        ...(extensions ? { filters: [{ name: extensions.join(', '), extensions }] } : {})
      }),
    quitToDesktop: deps.quit,
    detectHardware: () =>
      detectHardware({
        listSystemPrinters,
        listDisplays: () => screen.getAllDisplays().map((display) => ({ id: display.id, bounds: display.bounds }))
      }),
    showOnDisplay(order) {
      const display = windows.display()
      if (alive(display)) display.webContents.send(EVENT_CHANNEL, { type: 'display.order', order } satisfies AtlasEvent)
    },
    navigateTill(route) {
      const till = windows.till()
      if (!alive(till)) return
      // Through a blank page: a new document, so nothing of the previous database stays in the renderer.
      void till.loadURL('about:blank').then(() => loadRoute(till, route, config))
    }
  }
}
