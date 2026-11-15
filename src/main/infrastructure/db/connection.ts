import BetterSqlite3 from 'better-sqlite3'
import { DatabaseError } from './errors'

export type Database = BetterSqlite3.Database

/**
 * Opens (creating if needed) the SQLite file with the pragmas every connection must have:
 * - WAL and `synchronous=FULL`: a committed transaction is on disk before the call returns, which
 *   is what makes a power cut safe. Throws `wal_unavailable` if the file cannot use WAL.
 * - `foreign_keys=ON` and a 5 s busy wait.
 * - `recursive_triggers=ON`: without it `INSERT OR REPLACE` / `REPLACE INTO` evicts a conflicting
 *   row without firing its DELETE trigger, which would bypass the immutability triggers. The
 *   triggers only RAISE, so nothing recurses. The pragma is per connection, so every connection
 *   must be opened through here.
 * The handle is closed if any step fails.
 */
export function openDatabase(file: string): Database {
  const db = new BetterSqlite3(file)
  try {
    // First, so that the journal_mode switch below also waits for a concurrent writer.
    db.pragma('busy_timeout = 5000')
    const journalMode = db.pragma('journal_mode = WAL', { simple: true })
    if (journalMode !== 'wal') throw new DatabaseError('wal_unavailable', { journalMode, file })
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('recursive_triggers = ON')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * A read-only handle on an existing database file, for inspecting it without any chance of
 * changing it: start-up checks, and a database written by a newer app that must not be touched.
 * It sets no pragma that writes (no `journal_mode`), never creates the file, and cannot run
 * INSERT/UPDATE/DELETE. It can still read data that is only in the `-wal` file.
 */
export function openDatabaseReadOnly(file: string): Database {
  const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
