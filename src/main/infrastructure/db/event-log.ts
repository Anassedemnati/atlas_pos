import type { Clock } from '../../application/ports'
import type { Database } from './connection'

export interface EventInput {
  type: string
  entity: string
  entityId?: string
  userId?: string
  /** Serialised as JSON. */
  data?: unknown
}

/**
 * Appends one row to the append-only `event_log`, stamped by the injected clock. Call it inside
 * the use case's transaction (`appendEvent(tx.db, e, tx.clock)`) so the row commits or rolls back
 * with the change it describes.
 */
export function appendEvent(db: Database, e: EventInput, clock: Clock): void {
  db.prepare(
    `INSERT INTO event_log (at, type, entity, entity_id, user_id, data_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    clock.now().toISOString(),
    e.type,
    e.entity,
    e.entityId ?? null,
    e.userId ?? null,
    e.data === undefined ? null : JSON.stringify(e.data)
  )
}
