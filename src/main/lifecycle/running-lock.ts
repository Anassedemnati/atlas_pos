import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../infrastructure/fs/atomic'
import type { DataPaths } from '../paths'

export interface RunningLock {
  /** The previous run left its lock behind: it did not quit cleanly (crash, power cut, kill). */
  wasUnclean: boolean
  /** Deletes the lock. Call it on a clean quit only; idempotent. */
  release(): void
}

/**
 * Takes the `config/running.lock` marker for this run. A lock that is already there was left by an
 * unclean previous run. The marker is written durably (file and directory fsynced), so a power cut
 * right after start-up still leaves it behind. This is not an instance guard: one running copy is
 * enforced separately (Electron's single-instance lock).
 */
export function acquireRunningLock(paths: Pick<DataPaths, 'config'>): RunningLock {
  const file = join(paths.config, 'running.lock')
  const wasUnclean = existsSync(file)
  writeFileAtomic(file, `${process.pid}\n`)
  return { wasUnclean, release: () => rmSync(file, { force: true }) }
}
