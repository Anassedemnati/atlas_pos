import { BrowserWindow } from 'electron'
import { bgraToRgba, toMonochrome } from '../raster'
import type { Bitmap, DotWidth, RenderHtmlToBitmap } from '../types'
import { withReceiptFonts } from './fonts'

/** The window is first this tall; it is resized to the document once the fonts are in. */
const INITIAL_HEIGHT = 400
const LOAD_TIMEOUT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Renders the HTML in an off-screen window `widthDots` CSS pixels wide (one pixel is one thermal dot), waits
 * for the fonts, captures the whole page and turns it into a black and white bitmap. Each call uses its own
 * window, destroyed afterwards, so renders never share state.
 *
 * Needs a running app with its till window open: Electron quits by default when the last window closes, and
 * the app's own `window-all-closed` handler calls `app.quit()`, so a render with no other window open would end
 * the app. Start the print queue after the till window exists.
 */
export const renderHtmlToBitmap: RenderHtmlToBitmap = async (html: string, widthDots: DotWidth): Promise<Bitmap> => {
  const window = new BrowserWindow({
    show: false,
    width: widthDots,
    height: INITIAL_HEIGHT,
    useContentSize: true,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const timeout = setTimeout(() => window.destroy(), LOAD_TIMEOUT_MS)
  try {
    // The window is 1x whatever the screen: the capture is as wide as the paper, not twice.
    window.webContents.setZoomFactor(1)
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(withReceiptFonts(html))}`)
    // The body's own height: the document is never shorter than the window, so `scrollHeight` of the page would
    // always say at least INITIAL_HEIGHT and short tickets would come out with a blank tail.
    const height = Math.max(
      1,
      Math.ceil(
        await window.webContents.executeJavaScript('document.fonts.ready.then(() => document.body.getBoundingClientRect().height)')
      )
    )
    if (height > INITIAL_HEIGHT) {
      window.setContentSize(widthDots, height)
      // An off-screen window paints on a timer: let it paint the new size before capturing.
      await sleep(120)
    }
    let image = await window.webContents.capturePage({ x: 0, y: 0, width: widthDots, height })
    // A high-density screen gives a capture twice as wide: bring it back to one pixel per dot.
    if (image.getSize().width !== widthDots) image = image.resize({ width: widthDots, quality: 'best' })
    const { width, height: captured } = image.getSize()
    return toMonochrome(bgraToRgba(image.toBitmap()), width, captured)
  } finally {
    clearTimeout(timeout)
    if (!window.isDestroyed()) window.destroy()
  }
}
