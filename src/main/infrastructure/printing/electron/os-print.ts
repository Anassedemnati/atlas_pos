import { BrowserWindow } from 'electron'
import type { HtmlPrinter, RenderHtmlToPdf } from '../types'
import { withReceiptFonts } from './fonts'

const LOAD_TIMEOUT_MS = 30_000

async function inHiddenWindow<T>(html: string, use: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const timeout = setTimeout(() => window.destroy(), LOAD_TIMEOUT_MS)
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(withReceiptFonts(html))}`)
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    return await use(window)
  } finally {
    clearTimeout(timeout)
    if (!window.isDestroyed()) window.destroy()
  }
}

/** Prints HTML silently on a system printer with `webContents.print` (no dialog, the page size is the HTML's `@page`). */
export function createElectronHtmlPrinter(): HtmlPrinter {
  return {
    print: (html, deviceName) =>
      inHiddenWindow(
        html,
        (window) =>
          new Promise<void>((resolve, reject) => {
            window.webContents.print({ silent: true, deviceName, printBackground: true, margins: { marginType: 'none' } }, (success, reason) =>
              success ? resolve() : reject(new Error(reason || 'the system printer refused the job'))
            )
          })
      )
  }
}

/** The HTML as a PDF (A4 or whatever its `@page` says), for an invoice saved as a file. */
export const renderHtmlToPdf: RenderHtmlToPdf = (html) =>
  inHiddenWindow(html, (window) => window.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true }))
