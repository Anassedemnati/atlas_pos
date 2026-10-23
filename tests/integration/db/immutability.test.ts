import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDb, type TempDb } from '../../helpers/db'

const IMMUTABLE_TICKET_COLUMNS = [
  'id', 'kind', 'number', 'label', 'order_id', 'day_id', 'ref_ticket_id', 'closed_at', 'user_id',
  'total_cents', 'snapshot_json'
]

describe('immutability triggers', () => {
  let t: TempDb
  beforeEach(() => {
    t = tempDb()
    t.db
      .prepare(
        `INSERT INTO tickets (id, kind, number, label, order_id, day_id, ref_ticket_id, closed_at, user_id, total_cents, snapshot_json)
         VALUES ('t1', 'sale', 1, '000001', 'o1', 'd1', NULL, '2026-10-22T10:00:00.000Z', 'u1', 3800, '{}')`
      )
      .run()
  })
  afterEach(() => t.cleanup())

  describe('tickets', () => {
    it('guards every column except reprint_count (the trigger covers the whole table)', () => {
      const columns = (t.db.pragma('table_info(tickets)') as { name: string }[]).map((c) => c.name)
      expect(columns.filter((c) => c !== 'reprint_count').sort()).toEqual([...IMMUTABLE_TICKET_COLUMNS].sort())
    })

    it.each(IMMUTABLE_TICKET_COLUMNS)('rejects changing %s', (column) => {
      const row = t.db.prepare('SELECT * FROM tickets WHERE id = ?').get('t1') as Record<string, unknown>
      const old = row[column]
      const changed = typeof old === 'number' ? old + 1 : `${String(old ?? '')}x`
      expect(() => t.db.prepare(`UPDATE tickets SET ${column} = ? WHERE id = 't1'`).run(changed)).toThrow(
        /^ticket_immutable$/
      )
    })

    it('rejects updating total_cents and leaves the row untouched', () => {
      expect(() => t.db.prepare("UPDATE tickets SET total_cents = 1 WHERE id = 't1'").run()).toThrow(
        /^ticket_immutable$/
      )
      expect(t.db.prepare("SELECT total_cents FROM tickets WHERE id = 't1'").get()).toEqual({ total_cents: 3800 })
    })

    it('allows updating reprint_count', () => {
      t.db.prepare("UPDATE tickets SET reprint_count = reprint_count + 1 WHERE id = 't1'").run()
      expect(t.db.prepare("SELECT reprint_count FROM tickets WHERE id = 't1'").get()).toEqual({ reprint_count: 1 })
    })

    it('rejects an update that bumps reprint_count together with an immutable column', () => {
      expect(() =>
        t.db.prepare("UPDATE tickets SET reprint_count = 5, total_cents = 0 WHERE id = 't1'").run()
      ).toThrow(/^ticket_immutable$/)
      expect(t.db.prepare("SELECT reprint_count, total_cents FROM tickets WHERE id = 't1'").get()).toEqual({
        reprint_count: 0,
        total_cents: 3800
      })
    })

    it('rejects deleting a ticket', () => {
      expect(() => t.db.prepare("DELETE FROM tickets WHERE id = 't1'").run()).toThrow(/^ticket_immutable$/)
      expect(t.db.prepare('SELECT count(*) AS n FROM tickets').get()).toEqual({ n: 1 })
    })
  })

  describe('invoices', () => {
    beforeEach(() => {
      t.db
        .prepare(
          `INSERT INTO invoices (id, number_label, ticket_id, customer_json, created_at, user_id, snapshot_json)
           VALUES ('i1', 'F-2026-00001', 't1', '{}', '2026-10-22T10:00:00.000Z', 'u1', '{}')`
        )
        .run()
    })

    it('rejects any update', () => {
      expect(() => t.db.prepare("UPDATE invoices SET customer_json = '{\"x\":1}' WHERE id = 'i1'").run()).toThrow(
        /^invoice_immutable$/
      )
    })

    it('rejects deleting an invoice', () => {
      expect(() => t.db.prepare("DELETE FROM invoices WHERE id = 'i1'").run()).toThrow(/^invoice_immutable$/)
    })
  })

  describe('z_reports', () => {
    beforeEach(() => {
      t.db.prepare("INSERT INTO business_days (id, number, opened_at) VALUES ('d1', 1, 'now')").run()
      t.db
        .prepare(
          "INSERT INTO z_reports (id, day_id, number, data_json, created_at, user_id) VALUES ('z1', 'd1', 1, '{}', 'now', 'u1')"
        )
        .run()
    })

    it('rejects any update', () => {
      expect(() => t.db.prepare("UPDATE z_reports SET data_json = '{\"x\":1}' WHERE id = 'z1'").run()).toThrow(
        /^z_report_immutable$/
      )
    })

    it('rejects deleting a Z report', () => {
      expect(() => t.db.prepare("DELETE FROM z_reports WHERE id = 'z1'").run()).toThrow(/^z_report_immutable$/)
    })
  })
})
