import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Database, openDatabase } from '../../src/main/infrastructure/db/connection'
import { migrate } from '../../src/main/infrastructure/db/migrate'

export interface TempDb {
  db: Database
  /** The database file (inside a private temp directory, so `-wal` and `-shm` go with it). */
  path: string
  /** Closes the connection and removes the temp directory. Safe to call twice. */
  cleanup: () => void
}

/**
 * A real database file (not `:memory:`, which has no WAL) in a fresh temp directory.
 * Migrated to the latest schema unless `{ migrate: false }` is passed.
 */
export function tempDb(options: { migrate?: boolean } = {}): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-db-'))
  const path = join(dir, 'atlas.db')
  const db = openDatabase(path)
  const cleanup = (): void => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    if (options.migrate !== false) migrate(db)
  } catch (error) {
    cleanup()
    throw error
  }
  return { db, path, cleanup }
}
