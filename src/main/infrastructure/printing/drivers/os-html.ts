import { PermanentPrintError, type DriverJob, type HtmlPrinter, type PrinterDriver } from '../types'

/**
 * A printer of the operating system (laser, inkjet, or a thermal printer used through its Windows/CUPS
 * driver): the HTML is printed silently on `deviceName` through the Electron port.
 */
export function createOsHtmlDriver(deviceName: string, port: HtmlPrinter): PrinterDriver {
  return {
    kind: 'os-html',
    async send(job: DriverJob): Promise<void> {
      if (Buffer.isBuffer(job)) throw new PermanentPrintError('bytes_not_supported', 'a system printer takes documents, not ESC/POS bytes')
      await port.print(job.html, deviceName)
    }
  }
}
