import type { Database } from './connection'
import { DatabaseError } from './errors'
import init001 from './migrations/001_init.sql?raw'
import backup002 from './migrations/002_backup.sql?raw'
import pinLockout003 from './migrations/003_pin_lockout.sql?raw'
import orderLinesProductIdx004 from './migrations/004_order_lines_product_idx.sql?raw'
import orderDiscountApproval005 from './migrations/005_order_discount_approval.sql?raw'
import orderBillRequested006 from './migrations/006_order_bill_requested.sql?raw'

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
export const migrations: readonly Migration[] = [
  { version: 1, name: '001_init', sql: init001 },
  { version: 2, name: '002_backup', sql: backup002 },
  { version: 3, name: '003_pin_lockout', sql: pinLockout003 },
  { version: 4, name: '004_order_lines_product_idx', sql: orderLinesProductIdx004 },
  { version: 5, name: '005_order_discount_approval', sql: orderDiscountApproval005 },
  { version: 6, name: '006_order_bill_requested', sql: orderBillRequested006 }
]

const readVersion = (db: Database): number => db.pragma('user_version', { simple: true }) as number

/**
 * Applies the migrations newer than `PRAGMA user_version`, each one in its own transaction
 * together with its version bump: a failing file leaves the database exactly as it was.
 * Migration SQL must not contain BEGIN/COMMIT.
 *
 * A database whose `user_version` is higher than the number of known migrations was written by a
 * newer app: it is refused (`newer_schema`) before anything is touched. The version is always
 * read inside an IMMEDIATE transaction, i.e. under the write lock.
 */
export function migrate(db: Database, list: readonly Migration[] = migrations): { from: number; to: number } {
  list.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(`migration ${m.name}: expected version ${index + 1}, found ${m.version}`)
    }
  })

  const from = db
    .transaction(() => {
      const version = readVersion(db)
      if (version > list.length) throw new DatabaseError('newer_schema', { found: version, supported: list.length })
      return version
    })
    .immediate()

  let to = from
  for (const m of list) {
    to = db
      .transaction(() => {
        // Re-read under the lock: skips a migration that is already applied, whether by an earlier
        // run or by another connection since the read above.
        const version = readVersion(db)
        if (version >= m.version) return version
        db.exec(m.sql)
        db.exec(`PRAGMA user_version = ${m.version}`)
        return m.version
      })
      .immediate()
  }
  return { from, to }
}
