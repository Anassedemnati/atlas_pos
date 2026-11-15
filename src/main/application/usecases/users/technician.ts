import type { Result } from '@shared/result'
import { MAX_PASSWORD_LENGTH } from '../../../domain/users/credentials'
import { MAX_FAILED_LOGINS, TECHNICIAN_LOCK_MS } from '../../../domain/users/lockout'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { verifyAgainstDecoy, verifySecretAsync } from '../../../infrastructure/security/password'
import { AppErrorException } from '../../errors'
import type { Clock } from '../../ports'
import { createAttemptLimiter } from './attempt-limiter'
import { refuse } from './outcome'

export interface TechnicianUseCases {
  /**
   * Is `code` the technician code (the hash in setting `tech.codeHash`)?
   * - `{ ok: true, value: true }` for the right code.
   * - `invalid_credentials` for a wrong one, or while no code is set. The 5th failure in a row locks
   *   the check for 5 minutes (`locked`, `params.until`); a success resets the count. The count and
   *   the lock are kept in memory, so an application restart gives a fresh set of 5 tries; a lock is
   *   not logged per attempt, only once when it starts.
   * - `technician_unavailable` when the stored hash does not read back (`setting_corrupt`): not a
   *   guess, so it is neither counted nor mixed with `technician.failed` in the log. Any other
   *   error (the database) is thrown.
   * Asynchronous like the other logins: the hash runs on the thread pool. The code is never logged.
   */
  verifyTechnician(code: string): Promise<Result<true>>
}

export function createTechnicianUseCases(deps: {
  uow: UnitOfWork
  clock: Clock
  settings: SettingsRepo
}): TechnicianUseCases {
  const { uow, clock, settings } = deps
  const limiter = createAttemptLimiter(clock, { maxFailures: MAX_FAILED_LOGINS, lockMs: TECHNICIAN_LOCK_MS })
  const CHECK = 'technician'

  return {
    async verifyTechnician(code) {
      const blocked = limiter.lockedUntil(CHECK)
      if (blocked) return refuse('locked', { until: blocked })

      let hash: string | null
      try {
        hash = settings.get('tech.codeHash')
      } catch (error) {
        if (!(error instanceof AppErrorException) || error.code !== 'setting_corrupt') throw error
        uow.run((tx) => {
          appendEvent(tx.db, { type: 'technician.unavailable', entity: 'technician' }, tx.clock)
        })
        return refuse('technician_unavailable')
      }

      let ok = false
      // Over the cap it cannot be the code, and is not worth a hash.
      if (code.length <= MAX_PASSWORD_LENGTH) {
        if (hash === null) await verifyAgainstDecoy(code)
        else ok = await verifySecretAsync(code, hash)
      }

      // Parallel guesses can pass the first check: only the first 5 failures are counted, the rest find the lock.
      const lockedMeanwhile = limiter.lockedUntil(CHECK)
      if (lockedMeanwhile) return refuse('locked', { until: lockedMeanwhile })

      if (ok) {
        limiter.reset(CHECK)
        uow.run((tx) => {
          appendEvent(tx.db, { type: 'technician.verified', entity: 'technician' }, tx.clock)
        })
        return { ok: true, value: true }
      }
      const lock = limiter.fail(CHECK)
      uow.run((tx) => {
        appendEvent(tx.db, { type: 'technician.failed', entity: 'technician' }, tx.clock)
        if (lock) appendEvent(tx.db, { type: 'technician.locked', entity: 'technician', data: { until: lock.until } }, tx.clock)
      })
      return lock ? refuse('locked', { until: lock.until }) : refuse('invalid_credentials')
    }
  }
}
