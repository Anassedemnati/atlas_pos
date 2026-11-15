import { BrowserWindow } from 'electron'
import type { ListSystemPrinters } from '../types'

/** The printers installed in the operating system, as `webContents.getPrintersAsync` lists them. */
export const listSystemPrinters: ListSystemPrinters = async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    const printers = await window.webContents.getPrintersAsync()
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: (p.options as unknown as Record<string, unknown>)['is-default'] === 'true' }))
  } finally {
    window.destroy()
  }
}
