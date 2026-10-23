import type { Runtime } from '../composition/runtime'
import type { Logger } from '../logger'

export interface BackofficeDeps {
  /** Read on each request: the services are rebuilt after a restore. */
  runtime: Pick<Runtime, 'services'>
  log: Logger
}

/**
 * Starts the back office HTTP server (setting `backoffice.port`). Called once the setup is complete,
 * when `backoffice.enabled` is on. No-op until Task 22 provides the server; returns its stop function.
 */
export function startBackoffice(deps: BackofficeDeps): () => Promise<void> {
  deps.log.info('backoffice.not_available', { port: deps.runtime.services()?.settings.get('backoffice.port') ?? null })
  return async () => {}
}
