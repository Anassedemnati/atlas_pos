import type { FastifyInstance } from 'fastify'
import { createHttpServer, type HttpDeps } from '../interfaces/http/server'
import { describeError, type Logger } from '../logger'

export interface BackofficeDeps extends Omit<HttpDeps, 'log'> {
  log: Logger
  /** The renderer build folder (`out/renderer`) holding `backoffice.html`. */
  staticDir: string
}

/**
 * Starts the back office HTTP server on `0.0.0.0:<backoffice.port>`. Called once the setup is complete, when
 * `backoffice.enabled` is on. The server refuses every address outside the local network itself. A port that is
 * taken (or any other failure to listen) is logged and the till carries on without it; nothing here rejects.
 * Returns the function that stops it.
 */
export function startBackoffice(deps: BackofficeDeps): () => Promise<void> {
  const port = deps.runtime.services()?.settings.get('backoffice.port')
  if (port === undefined) {
    deps.log.warn('backoffice.not_started', { reason: 'no database' })
    return async () => {}
  }
  const { staticDir, ...http } = deps
  let server: FastifyInstance | null = null
  try {
    server = createHttpServer(http, { port, staticDir })
  } catch (error) {
    deps.log.error('backoffice.create_failed', describeError(error))
    return async () => {}
  }
  const running = server
    .listen({ host: '0.0.0.0', port })
    .then(() => deps.log.info('backoffice.listening', { port }))
    .catch((error: unknown) => deps.log.error('backoffice.listen_failed', { port, ...describeError(error) }))
  return async () => {
    await running
    await server?.close().catch(() => {})
    server = null
  }
}
