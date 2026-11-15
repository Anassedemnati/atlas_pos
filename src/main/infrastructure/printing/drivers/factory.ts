import type { Clock } from '../../../application/ports'
import { PermanentPrintError, type HtmlPrinter, type PrinterDriver, type PrinterRow, type RenderHtmlToBitmap } from '../types'
import { createDeviceFileDriver } from './device-file'
import { createNetworkDriver, parseHostPort } from './network'
import { createOsHtmlDriver } from './os-html'
import { createSerialDriver, parseSerialAddress, type OpenSerial } from './serial'
import { createVirtualDriver } from './virtual'
import { createWindowsRawDriver, type WindowsRawIo } from './windows-raw'

/** What the drivers need from the machine; every piece but `printsDir` and `clock` has a real default or is optional. */
export interface DriverEnv {
  /** `<data dir>/prints`, where virtual printers write. */
  printsDir: string
  clock: Clock
  /** Renders HTML for the PNG of a virtual printer's document job (Electron). */
  renderHtml?: RenderHtmlToBitmap
  /** Sends HTML to a system printer (Electron); without it an `os-html` printer cannot be used. */
  htmlPrinter?: HtmlPrinter
  openSerial?: OpenSerial
  windowsRaw?: WindowsRawIo
  networkTimeoutMs?: number
}

const required = (printer: PrinterRow): string => {
  if (printer.address.trim() === '') throw new PermanentPrintError('printer_misconfigured', `printer "${printer.name}" has no address`)
  return printer.address
}

/**
 * The driver for a printer, by its kind. Throws a `PermanentPrintError` for what no retry can fix: an
 * unknown kind, a missing or malformed address, a system printer with no Electron port.
 */
export function createDriver(printer: PrinterRow, env: DriverEnv): PrinterDriver {
  switch (printer.kind) {
    case 'network':
      parseHostPort(required(printer))
      return createNetworkDriver(printer.address, { timeoutMs: env.networkTimeoutMs })
    case 'serial':
      parseSerialAddress(required(printer))
      return createSerialDriver(printer.address, { open: env.openSerial })
    case 'device-file':
      return createDeviceFileDriver(required(printer))
    case 'windows-raw':
      return createWindowsRawDriver(required(printer), env.windowsRaw)
    case 'os-html':
      if (!env.htmlPrinter) throw new PermanentPrintError('os_printing_unavailable', 'system printing is not available here')
      return createOsHtmlDriver(required(printer), env.htmlPrinter)
    case 'virtual':
      return createVirtualDriver({
        dir: env.printsDir,
        printerName: printer.name,
        clock: env.clock,
        renderHtml: env.renderHtml,
        widthMm: printer.widthMm
      })
    default:
      throw new PermanentPrintError('unknown_printer_kind', `unknown printer kind "${printer.kind}"`)
  }
}
