import { copyFileSync, fsyncSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../../application/ports'
import type { DataPaths } from '../../paths'
import type { Database } from './connection'
import { migrations } from './migrate'

/**
 * Before an update migrates an existing database (spec §7.2): a plain copy of it, as it was, in
 * `backups/pre-migration-<ts>-v<from>.db`. The WAL is folded into the file first (`wal_checkpoint(TRUNCATE)`),
 * so the copy alone is the whole database. Nothing to do for a database that is current, or that has no
 * schema yet. Returns what was copied, or null. Throws when the copy fails: migrating without it is refused.
 */
export function backupBeforeMigration(
  db: Database,
  paths: Pick<DataPaths, 'dbFile' | 'backups'>,
  clock: Clock
): { from: number; file: string } | null {
  const from = db.pragma('user_version', { simple: true }) as number
  if (from < 1 || from >= migrations.length) return null
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
  // Another connection held the WAL: the file alone would miss its committed pages.
  if (!checkpoint || checkpoint.busy !== 0) throw new Error('pre-migration backup: the WAL could not be checkpointed')
  const stamp = clock.now().toISOString().replace(/[-:.]/g, '')
  const file = join(paths.backups, `pre-migration-${stamp}-v${from}.db`)
  copyFileSync(paths.dbFile, file)
  const fd = openSync(file, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { from, file }
}
