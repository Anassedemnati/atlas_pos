import { appendEvent } from '../../../infrastructure/db/event-log'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { verifyAgainstDecoy, verifySecretAsync } from '../../../infrastructure/security/password'

export interface TechnicianUseCases {
  /**
   * Is `code` the technician code (the hash in setting `tech.codeHash`)? False while no code is set.
   * Asynchronous like the other logins: the hash runs on the thread pool. The attempt is logged,
   * never the code. It is not rate-limited.
   */
  verifyTechnician(code: string): Promise<boolean>
}

export function createTechnicianUseCases(deps: { uow: UnitOfWork; settings: SettingsRepo }): TechnicianUseCases {
  const { uow, settings } = deps
  return {
    async verifyTechnician(code) {
      let hash: string | null = null
      try {
        hash = settings.get('tech.codeHash')
      } catch {
        // A stored value that does not read back is "no code": nothing opens the technician menu.
      }
      let ok = false
      if (hash === null) await verifyAgainstDecoy(code)
      else ok = await verifySecretAsync(code, hash)
      uow.run((tx) => {
        appendEvent(tx.db, { type: ok ? 'technician.verified' : 'technician.failed', entity: 'technician' }, tx.clock)
      })
      return ok
    }
  }
}
