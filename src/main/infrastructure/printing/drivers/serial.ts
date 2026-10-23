import { PermanentPrintError, type DriverJob, type PrinterDriver } from '../types'

export const DEFAULT_BAUD_RATE = 9600

/** `COM3` or `/dev/ttyUSB0@19200`: the port and its baud rate (9600 by default). */
export function parseSerialAddress(address: string): { path: string; baudRate: number } {
  const [path = '', baud] = address.trim().split('@')
  const baudRate = baud === undefined ? DEFAULT_BAUD_RATE : Number(baud)
  if (path === '' || !Number.isInteger(baudRate) || baudRate <= 0) {
    throw new PermanentPrintError('printer_misconfigured', `"${address}" is not a serial port[@baud] address`)
  }
  return { path, baudRate }
}

/** An open serial port. */
export interface SerialConnection {
  /** Resolves once the bytes have left the port. */
  write(data: Buffer): Promise<void>
  close(): Promise<void>
}

export type OpenSerial = (path: string, baudRate: number) => Promise<SerialConnection>

/** Opens a port with the `serialport` module (loaded on first use: it carries a native binding). */
export const openSerialPort: OpenSerial = async (path, baudRate) => {
  const { SerialPort } = await import('serialport')
  const port = new SerialPort({ path, baudRate, autoOpen: false })
  await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())))
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        port.write(data, (error) => (error ? reject(error) : port.drain((drainError) => (drainError ? reject(drainError) : resolve()))))
      }),
    close: () => new Promise<void>((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve()))
  }
}

/** A printer on a serial (or USB-serial) port: open, write, close for each job. */
export function createSerialDriver(address: string, options: { open?: OpenSerial } = {}): PrinterDriver {
  const open = options.open ?? openSerialPort
  return {
    kind: 'serial',
    async send(job: DriverJob): Promise<void> {
      if (!Buffer.isBuffer(job)) throw new PermanentPrintError('html_not_supported', 'a serial printer takes ESC/POS bytes')
      const { path, baudRate } = parseSerialAddress(address)
      const port = await open(path, baudRate)
      try {
        await port.write(job)
      } finally {
        await port.close().catch(() => undefined)
      }
    }
  }
}
