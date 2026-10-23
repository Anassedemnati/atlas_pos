import BetterSqlite3 from 'better-sqlite3'

export type Database = BetterSqlite3.Database

/**
 * Opens (creating if needed) the SQLite file with the pragmas every connection must have:
 * WAL, `synchronous=FULL` (a committed transaction is on disk before the call returns, which is
 * what makes a power cut safe), enforced foreign keys and a 5 s busy wait.
 */
export function openDatabase(file: string): Database {
  const db = new BetterSqlite3(file)
  // First, so that the journal_mode switch below also waits for a concurrent writer.
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  return db
}
