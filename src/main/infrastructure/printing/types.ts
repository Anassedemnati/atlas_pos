import type { Lang } from '@shared/names'

/**
 * A monochrome image as the printer wants it: rows top to bottom, each `ceil(width / 8)` bytes, the leftmost
 * pixel in the most significant bit, a set bit is a black dot.
 */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

/** A row of `printers`, as the printing code reads it. */
export interface PrinterRow {
  id: string
  name: string
  /**
   * `network`, `serial`, `device-file`, `windows-raw`, `os-html` or `virtual`. Stored as free text, so an unknown
   * value is refused (for good) when a driver is asked for.
   */
  kind: string
  /**
   * What the kind needs to reach the device: `host[:port]` (network, port 9100 by default), the serial
   * path with an optional `@baud` (`COM3@19200`, 9600 by default), the device file, the Windows printer
   * name, the system printer name (os-html); unused by a virtual printer.
   */
  address: string
  widthMm: number
  /** Language of kitchen tickets and test pages printed here. */
  lang: Lang
  /** Print everything as an image, whatever the language. */
  raster: boolean
  role: string
  active: boolean
}

/** What a driver sends: the bytes of an ESC/POS job, or an HTML document for a system printer. */
export type DriverJob = Buffer | { html: string }

export interface PrinterDriver {
  kind: string
  /** Resolves when the job has been handed to the device; rejects with the reason it was not. */
  send(job: DriverJob): Promise<void>
}

/** A document ready to print: ESC/POS bytes, or HTML (to rasterise for a thermal printer, or to hand to the OS). */
export type PrintDoc =
  | { escpos: Buffer }
  | {
      html: string
      /** True: this HTML stands in for ESC/POS text and is rasterised for a thermal printer. */
      raster?: boolean
      widthMm?: number
    }

export type DotWidth = 576 | 384

/** Port: HTML in, monochrome bitmap `widthDots` wide out (Electron implements it; tests fake it). */
export type RenderHtmlToBitmap = (html: string, widthDots: DotWidth) => Promise<Bitmap>

/** Port: sends an HTML document to a system printer, silently (Electron `webContents.print`). */
export interface HtmlPrinter {
  print(html: string, deviceName: string): Promise<void>
}

/** Port: an HTML document as a PDF (Electron `webContents.printToPDF`), for invoices saved as files. */
export type RenderHtmlToPdf = (html: string) => Promise<Buffer>

/** A printer the operating system knows. */
export interface SystemPrinter {
  /** The name to store in a printer's `address` (system and Windows RAW printers). */
  name: string
  displayName: string
  isDefault: boolean
}

/** Port: the printers installed in the operating system (Electron `webContents.getPrintersAsync`). */
export type ListSystemPrinters = () => Promise<SystemPrinter[]>

/** A failure retrying cannot cure (an unknown printer kind, a job nobody can render). The queue gives up at once. */
export class PermanentPrintError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.name = 'PermanentPrintError'
    this.code = code
  }
}
