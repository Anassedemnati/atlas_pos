import type { DayDto, ZData } from '@shared/dto'
import type { Database } from '../connection'
import type { Tx } from '../uow'

interface DayRow {
  id: string
  number: number
  opened_at: string
  closed_at: string | null
}

const toDay = (row: DayRow): DayDto => ({
  id: row.id,
  number: row.number,
  openedAt: row.opened_at,
  closedAt: row.closed_at
})

export interface ZRecord {
  id: string
  dayId: string
  number: number
  data: ZData
  createdAt: string
  userId: string
}

export interface DaysRepo {
  /** The business day not closed by a Z yet (there is at most one). */
  openDay(): DayDto | undefined
  get(id: string): DayDto | undefined
  /** The number of the newest day, 0 before the first one. */
  lastNumber(): number
  /** How many events of `type` carry `dayId` in their data (reprints of the day). */
  countDayEvents(type: string, dayId: string): number
  getZ(dayId: string): ZRecord | undefined
  insert(tx: Tx, day: DayDto): void
  close(tx: Tx, id: string, closedAt: string): void
  insertZ(tx: Tx, z: ZRecord): void
}

export function createDaysRepo(db: Database): DaysRepo {
  return {
    openDay() {
      const row = db.prepare('SELECT * FROM business_days WHERE closed_at IS NULL ORDER BY number LIMIT 1').get() as
        | DayRow
        | undefined
      return row ? toDay(row) : undefined
    },

    get(id) {
      const row = db.prepare('SELECT * FROM business_days WHERE id = ?').get(id) as DayRow | undefined
      return row ? toDay(row) : undefined
    },

    lastNumber: () => (db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM business_days').get() as { n: number }).n,

    countDayEvents: (type, dayId) =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM event_log WHERE type = ? AND json_extract(data_json, '$.dayId') = ?")
          .get(type, dayId) as { n: number }
      ).n,

    getZ(dayId) {
      const row = db.prepare('SELECT * FROM z_reports WHERE day_id = ?').get(dayId) as
        | { id: string; day_id: string; number: number; data_json: string; created_at: string; user_id: string }
        | undefined
      return row
        ? {
            id: row.id,
            dayId: row.day_id,
            number: row.number,
            data: JSON.parse(row.data_json) as ZData,
            createdAt: row.created_at,
            userId: row.user_id
          }
        : undefined
    },

    insert(tx, day) {
      tx.db
        .prepare('INSERT INTO business_days (id, number, opened_at, closed_at) VALUES (?, ?, ?, ?)')
        .run(day.id, day.number, day.openedAt, day.closedAt)
    },

    close(tx, id, closedAt) {
      tx.db.prepare('UPDATE business_days SET closed_at = ? WHERE id = ?').run(closedAt, id)
    },

    insertZ(tx, z) {
      tx.db
        .prepare('INSERT INTO z_reports (id, day_id, number, data_json, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(z.id, z.dayId, z.number, JSON.stringify(z.data), z.createdAt, z.userId)
    }
  }
}
