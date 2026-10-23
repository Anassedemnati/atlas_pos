import type { Database } from './connection'
import init001 from './migrations/001_init.sql?raw'

export interface Migration {
  /** 1, 2, 3, ... without gaps: the value stored in `PRAGMA user_version` once applied. */
  version: number
  /** The file name without `.sql`, e.g. `001_init`. */
  name: string
  sql: string
}

/**
 * Every `migrations/NNN_*.sql` file, in order. Adding a migration means adding the file and one
 * line here (a test fails if a file is not registered). Files are bundled as Vite `?raw` strings,
 * so they ship inside the main bundle.
 */
export const migrations: readonly Migration[] = [{ version: 1, name: '001_init', sql: init001 }]

/**
 * Applies the migrations newer than `PRAGMA user_version`, each one in its own transaction
 * together with its version bump: a failing file leaves the database exactly as it was.
 * Migration SQL must not contain BEGIN/COMMIT.
 */
export function migrate(db: Database, list: readonly Migration[] = migrations): { from: number; to: number } {
  list.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(`migration ${m.name}: expected version ${index + 1}, found ${m.version}`)
    }
  })

  const from = db.pragma('user_version', { simple: true }) as number
  let current = from
  for (const m of list) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
    }).immediate()
    current = m.version
  }
  return { from, to: current }
}
