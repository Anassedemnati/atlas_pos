import { open } from 'node:fs/promises'
import { PermanentPrintError, type DriverJob, type PrinterDriver } from '../types'

/** A printer exposed as a device file (Linux `/dev/usb/lp0`): the bytes are appended to it. */
export function createDeviceFileDriver(path: string): PrinterDriver {
  return {
    kind: 'device-file',
    async send(job: DriverJob): Promise<void> {
      if (!Buffer.isBuffer(job)) throw new PermanentPrintError('html_not_supported', 'a device file takes ESC/POS bytes')
      const file = await open(path, 'a')
      try {
        await file.write(job)
      } finally {
        await file.close()
      }
    }
  }
}
