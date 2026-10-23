import { join } from 'node:path'
import pino from 'pino'

/** `(event, data)` as the start-up check, the backup engine and the print queue log. */
export type LogFn = (event: string, data?: Record<string, unknown>) => void

export interface Logger {
  info: LogFn
  warn: LogFn
  error: LogFn
  /** Writes out what is buffered (before the process exits). */
  flush(): void
}

/** Turns an error into something JSON can carry. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { name: error.name, message: error.message, ...(code !== undefined ? { code } : {}), stack: error.stack }
  }
  return { message: String(error) }
}

function fromPino(log: pino.Logger, flush: () => void): Logger {
  return {
    info: (event, data) => log.info({ event, ...data }),
    warn: (event, data) => log.warn({ event, ...data }),
    error: (event, data) => log.error({ event, ...data }),
    flush
  }
}

/** Until the data directory is known: standard error. */
export function createConsoleLogger(): Logger {
  return fromPino(pino({ base: undefined }, pino.destination(2)), () => {})
}

/** JSON lines in `<logs>/app.log` (the technician's Journal reads it); also on standard error in development. */
export function createFileLogger(logsDir: string, alsoConsole: boolean): Logger {
  const file = pino.destination({ dest: join(logsDir, 'app.log'), mkdir: true, sync: false })
  const streams: pino.StreamEntry[] = [{ stream: file }]
  if (alsoConsole) streams.push({ stream: pino.destination(2) })
  return fromPino(pino({ base: { pid: process.pid } }, pino.multistream(streams)), () => file.flushSync())
}
