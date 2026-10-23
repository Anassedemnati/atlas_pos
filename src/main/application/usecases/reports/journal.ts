import type { Result } from '@shared/result'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { attemptSync, invalidInput } from '../users/outcome'

export const DEFAULT_JOURNAL_LIMIT = 100
export const MAX_JOURNAL_LIMIT = 500

export interface JournalLine {
  id: number
  at: string
  type: string
  entity: string
  entityId: string | null
  userId: string | null
  /** The display name of `userId` when that user still exists. */
  userName: string | null
  data: unknown
}

export interface Journal {
  lines: JournalLine[]
  /** Every event type found in the log, for the filter. */
  types: string[]
}

export interface JournalQuery {
  /** An exact type (`catalog.imported`) or a family (`user` for `user.login`, `user.locked`...). */
  type?: string
  limit?: number
}

interface Row {
  id: number
  at: string
  type: string
  entity: string
  entity_id: string | null
  user_id: string | null
  data_json: string | null
  user_name: string | null
}

function parseData(json: string | null): unknown {
  if (json === null) return null
  try {
    return JSON.parse(json) as unknown
  } catch {
    return json
  }
}

/** The newest lines of the append-only event log, newest first. */
export function readJournal(db: Database, query: JournalQuery): Journal {
  const limit = query.limit ?? DEFAULT_JOURNAL_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOURNAL_LIMIT) throw invalidInput('limit', `1 to ${MAX_JOURNAL_LIMIT}`)
  const type = query.type?.trim() ?? ''
  if (type.length > 80) throw invalidInput('type', 'too long')
  const rows = (
    type === ''
      ? db
          .prepare(
            `SELECT e.*, u.display_name AS user_name FROM event_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`
          )
          .all(limit)
      : db
          .prepare(
            `SELECT e.*, u.display_name AS user_name FROM event_log e LEFT JOIN users u ON u.id = e.user_id
             WHERE e.type = ? OR substr(e.type, 1, length(?) + 1) = ? || '.' ORDER BY e.id DESC LIMIT ?`
          )
          .all(type, type, type, limit)
  ) as Row[]
  return {
    lines: rows.map((row) => ({
      id: row.id,
      at: row.at,
      type: row.type,
      entity: row.entity,
      entityId: row.entity_id,
      userId: row.user_id,
      userName: row.user_name,
      data: parseData(row.data_json)
    })),
    types: db.prepare('SELECT DISTINCT type FROM event_log ORDER BY type').pluck().all() as string[]
  }
}

export interface JournalUseCases {
  /** Needs `settings.manage`. */
  journal(session: Session, query: JournalQuery): Result<Journal>
}

export function createJournalUseCases(deps: { db: Database }): JournalUseCases {
  return {
    journal: (session, query) =>
      attemptSync(() => {
        requirePermission(session, 'settings.manage')
        return readJournal(deps.db, query)
      })
  }
}
