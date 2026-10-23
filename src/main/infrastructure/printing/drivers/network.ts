import { createConnection } from 'node:net'
import { PermanentPrintError, type DriverJob, type PrinterDriver } from '../types'

export const DEFAULT_NETWORK_TIMEOUT_MS = 5000
const DEFAULT_PORT = 9100

/** `192.168.1.50` or `printer.lan:9101`: the host and the port (9100, the raw printing port, by default). */
export function parseHostPort(address: string): { host: string; port: number } {
  const parts = address.trim().split(':')
  const [host = '', portText] = parts
  const port = portText === undefined ? DEFAULT_PORT : Number(portText)
  if (parts.length > 2 || host === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PermanentPrintError('printer_misconfigured', `"${address}" is not a host[:port] address`)
  }
  return { host, port }
}

/**
 * A network printer on raw TCP (port 9100). One connection per job; resolves once the whole job has been
 * handed to the network stack, rejects with the system error (`ECONNREFUSED`...) or `ETIMEDOUT` after
 * `timeoutMs` (5 s) if the printer does not take the data.
 */
export function createNetworkDriver(address: string, options: { timeoutMs?: number } = {}): PrinterDriver {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS
  return {
    kind: 'network',
    send(job: DriverJob): Promise<void> {
      if (!Buffer.isBuffer(job)) return Promise.reject(new PermanentPrintError('html_not_supported', 'a network printer takes ESC/POS bytes'))
      return new Promise<void>((resolve, reject) => {
        const { host, port } = parseHostPort(address)
        const socket = createConnection({ host, port })
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // Everything is in the kernel's send buffer by now; closing still delivers it.
          socket.destroy()
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => finish(Object.assign(new Error(`no answer from ${host}:${port} after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })), timeoutMs)
        socket.once('error', finish)
        socket.once('connect', () => socket.end(job, () => finish()))
      })
    }
  }
}
