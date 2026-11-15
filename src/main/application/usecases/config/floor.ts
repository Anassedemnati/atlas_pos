import type { FloorDto } from '@shared/dto'
import type { Result } from '@shared/result'
import { z } from 'zod'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync, invalidInput } from '../users/outcome'
import { listFloor } from './lists'

const Id = z.string().min(1).max(64)
const Coordinate = z.number().int().min(0).max(100_000)
const Size = z.number().int().min(1).max(10_000)

const FloorSchema = z.strictObject({
  rooms: z
    .array(
      z.strictObject({
        id: Id,
        name: z.strictObject({
          fr: z.string().trim().min(1).max(100),
          ar: z.string().trim().max(100).optional(),
          en: z.string().trim().max(100).optional()
        })
      })
    )
    .max(50),
  tables: z
    .array(
      z.strictObject({
        id: Id,
        roomId: Id,
        label: z.string().trim().min(1).max(40),
        shape: z.enum(['square', 'round', 'rect']),
        x: Coordinate,
        y: Coordinate,
        w: Size,
        h: Size,
        seats: z.number().int().min(1).max(99)
      })
    )
    .max(500)
})

export type FloorInput = z.input<typeof FloorSchema>

export interface FloorService {
  /**
   * Needs `settings.manage`. Replaces the floor plan with `rooms` (in this order) and `tables`: what is listed is
   * created or updated (an id the database does not know is new), an active table that is not listed is removed, and
   * so is a room that is not listed. A table with an open or parked order cannot be removed (`table_in_use`,
   * `params.label`); one that past orders point at is deactivated instead of deleted (their tickets keep its label),
   * and moved to the first room when its own room goes. Table labels are unique within a room. Announces
   * `catalog.changed`, which the till answers by reading the floor again. Returns the plan as saved.
   */
  saveFloor(session: Session, input: FloorInput): Result<FloorDto>
}

interface TableRow {
  id: string
  room_id: string
  label: string
  active: number
}

export function createFloorService(deps: { db: Database; uow: UnitOfWork }): FloorService {
  const { db, uow } = deps

  function save(session: Session, raw: FloorInput): FloorDto {
    requirePermission(session, 'settings.manage')
    const input = parseInput(FloorSchema, raw)
    return uow.run((tx) => {
      const roomIds = new Set(input.rooms.map((r) => r.id))
      if (roomIds.size !== input.rooms.length) throw invalidInput('rooms', 'duplicate room')
      const tableIds = new Set(input.tables.map((t) => t.id))
      if (tableIds.size !== input.tables.length) throw invalidInput('tables', 'duplicate table')
      const labels = new Set<string>()
      input.tables.forEach((table, index) => {
        if (!roomIds.has(table.roomId)) throw invalidInput(`tables.${index}.roomId`, 'unknown room')
        const key = `${table.roomId}\u0000${table.label.toLowerCase()}`
        if (labels.has(key)) throw invalidInput(`tables.${index}.label`, 'duplicate label')
        labels.add(key)
      })

      const existing = tx.db.prepare('SELECT id, room_id, label, active FROM tables').all() as TableRow[]
      const inUse = new Set(
        tx.db.prepare("SELECT DISTINCT table_id FROM orders WHERE status IN ('open', 'parked') AND table_id IS NOT NULL").pluck().all() as string[]
      )
      const removed = existing.filter((t) => t.active === 1 && !tableIds.has(t.id))
      const busy = removed.find((t) => inUse.has(t.id))
      if (busy) throw new AppErrorException('table_in_use', { tableId: busy.id, label: busy.label })

      input.rooms.forEach((room, sort) => {
        tx.db
          .prepare('INSERT INTO rooms (id, name_json, sort) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name_json = excluded.name_json, sort = excluded.sort')
          .run(room.id, JSON.stringify(room.name), sort)
      })
      const upsert = tx.db.prepare(
        `INSERT INTO tables (id, room_id, label, shape, x, y, w, h, seats, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET room_id = excluded.room_id, label = excluded.label, shape = excluded.shape,
           x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, seats = excluded.seats, active = 1`
      )
      for (const t of input.tables) upsert.run(t.id, t.roomId, t.label, t.shape, t.x, t.y, t.w, t.h, t.seats)

      for (const table of removed) {
        const referenced = tx.db.prepare('SELECT 1 FROM orders WHERE table_id = ? LIMIT 1').pluck().get(table.id) !== undefined
        if (referenced) tx.db.prepare('UPDATE tables SET active = 0 WHERE id = ?').run(table.id)
        else tx.db.prepare('DELETE FROM tables WHERE id = ?').run(table.id)
      }

      // A room that is not listed goes; the tables it still holds (deactivated ones, kept for the history) move to the first room.
      const goneRooms = (tx.db.prepare('SELECT id FROM rooms').pluck().all() as string[]).filter((id) => !roomIds.has(id))
      for (const roomId of goneRooms) {
        const left = tx.db.prepare('SELECT COUNT(*) FROM tables WHERE room_id = ?').pluck().get(roomId) as number
        if (left > 0) {
          const fallback = input.rooms[0]
          if (!fallback) throw invalidInput('rooms', 'keep one room: tables kept for the history need one')
          tx.db.prepare('UPDATE tables SET room_id = ? WHERE room_id = ?').run(fallback.id, roomId)
        }
        tx.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
      }

      appendEvent(
        tx.db,
        {
          type: 'floor.saved',
          entity: 'floor',
          userId: session.userId,
          data: { rooms: input.rooms.length, tables: input.tables.length, removedTables: removed.length, removedRooms: goneRooms.length }
        },
        tx.clock
      )
      tx.events.push({ type: 'catalog.changed' })
      return listFloor(db)
    })
  }

  return { saveFloor: (session, input) => attemptSync(() => save(session, input)) }
}
