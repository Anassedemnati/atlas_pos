import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDb, type TempDb } from '../../helpers/db'

describe('schema v1 constraints', () => {
  let t: TempDb
  beforeEach(() => {
    t = tempDb()
  })
  afterEach(() => t.cleanup())

  it('enforces foreign keys', () => {
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO products (id, category_id, name_json, price_cents, vat_bp) VALUES ('p', 'missing', '{}', 100, 1000)"
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
  })

  it('rejects values outside a listed enum', () => {
    t.db.prepare("INSERT INTO business_days (id, number, opened_at) VALUES ('d', 1, 'now')").run()
    const insertOrder = (type: string, status: string): void => {
      t.db
        .prepare(
          `INSERT INTO orders (id, day_id, type, status, user_id, opened_at, updated_at)
           VALUES (hex(randomblob(8)), 'd', ?, ?, 'u', 'now', 'now')`
        )
        .run(type, status)
    }
    expect(() => insertOrder('dine_in', 'open')).not.toThrow()
    expect(() => insertOrder('drive_thru', 'open')).toThrow(/CHECK/)
    expect(() => insertOrder('dine_in', 'paid')).toThrow(/CHECK/)
  })

  it('keeps ticket numbers and labels unique, per kind', () => {
    const insertTicket = (id: string, kind: string, number: number, label: string): void => {
      t.db
        .prepare(
          `INSERT INTO tickets (id, kind, number, label, order_id, day_id, closed_at, user_id, total_cents, snapshot_json)
           VALUES (?, ?, ?, ?, 'o', 'd', 'now', 'u', 100, '{}')`
        )
        .run(id, kind, number, label)
    }
    insertTicket('t1', 'sale', 1, '000001')
    insertTicket('t2', 'credit', 1, 'AV-000001') // same number, other kind: allowed
    expect(() => insertTicket('t3', 'sale', 1, '000099')).toThrow(/UNIQUE/)
    expect(() => insertTicket('t4', 'sale', 2, '000001')).toThrow(/UNIQUE/)
  })

  it('allows several users without a username but not two equal usernames', () => {
    t.db.prepare("INSERT INTO profiles (id, name_json, permissions_json) VALUES ('pr', '{}', '[]')").run()
    const insertUser = (id: string, username: string | null): void => {
      t.db
        .prepare(
          "INSERT INTO users (id, display_name, pin_hash, username, profile_id, created_at) VALUES (?, 'n', 'h', ?, 'pr', 'now')"
        )
        .run(id, username)
    }
    insertUser('u1', null)
    insertUser('u2', null)
    insertUser('u3', 'owner')
    expect(() => insertUser('u4', 'owner')).toThrow(/UNIQUE/)
  })
})
