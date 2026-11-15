import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../../src/main/infrastructure/db/event-log'
import { fixedClock } from '../../helpers/clock'
import { tempDb, type TempDb } from '../../helpers/db'

describe('appendEvent', () => {
  let t: TempDb
  beforeEach(() => {
    t = tempDb()
  })
  afterEach(() => t.cleanup())

  const rows = (): Record<string, unknown>[] => t.db.prepare('SELECT * FROM event_log ORDER BY id').all() as Record<string, unknown>[]

  it('writes a row stamped by the injected clock', () => {
    appendEvent(
      t.db,
      { type: 'ticket.closed', entity: 'ticket', entityId: 't1', userId: 'u1', data: { totalCents: 3800 } },
      fixedClock('2026-10-22T10:30:00.000Z')
    )
    expect(rows()).toEqual([
      {
        id: 1,
        at: '2026-10-22T10:30:00.000Z',
        type: 'ticket.closed',
        entity: 'ticket',
        entity_id: 't1',
        user_id: 'u1',
        data_json: '{"totalCents":3800}'
      }
    ])
  })

  it('stores NULL for the optional fields that are absent', () => {
    appendEvent(t.db, { type: 'day.opened', entity: 'day' }, fixedClock())
    expect(rows()[0]).toMatchObject({ entity_id: null, user_id: null, data_json: null })
  })

  it('appends in order', () => {
    appendEvent(t.db, { type: 'a', entity: 'x' }, fixedClock('2026-10-22T10:00:00.000Z'))
    appendEvent(t.db, { type: 'b', entity: 'x' }, fixedClock('2026-10-22T10:00:01.000Z'))
    expect(rows().map((r) => [r['id'], r['type'], r['at']])).toEqual([
      [1, 'a', '2026-10-22T10:00:00.000Z'],
      [2, 'b', '2026-10-22T10:00:01.000Z']
    ])
  })

  it('rolls back with the surrounding transaction', () => {
    expect(() =>
      t.db.transaction(() => {
        appendEvent(t.db, { type: 'a', entity: 'x' }, fixedClock())
        throw new Error('boom')
      })()
    ).toThrow('boom')
    expect(rows()).toEqual([])
  })
})
