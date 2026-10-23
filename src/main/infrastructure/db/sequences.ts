import type { Database } from './connection'

/**
 * Next value of a gap-free counter (1, 2, 3, ...). It must run inside the caller's transaction:
 * if that transaction rolls back, so does the increment, and the number is handed out again.
 */
export function nextSequence(db: Database, name: string): number {
  if (!db.inTransaction) {
    throw new Error(`nextSequence("${name}") must run inside a transaction, or a rollback would leave a gap`)
  }
  const row = db
    .prepare(
      `INSERT INTO sequences (name, value) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET value = value + 1
       RETURNING value`
    )
    .get(name) as { value: number }
  return row.value
}

/** Sets a counter, creating it if needed: the next `nextSequence` returns `value + 1`. */
export function resetSequence(db: Database, name: string, value = 0): void {
  db.prepare(
    `INSERT INTO sequences (name, value) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value`
  ).run(name, value)
}
