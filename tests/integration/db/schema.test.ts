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

  describe('join tables', () => {
    const count = (table: string): number =>
      (t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

    beforeEach(() => {
      t.db.exec(`
        INSERT INTO categories (id, name_json, color) VALUES ('c1', '{}', '#000');
        INSERT INTO products (id, category_id, name_json, price_cents, vat_bp) VALUES ('p1', 'c1', '{}', 100, 1000);
        INSERT INTO modifier_groups (id, name_json) VALUES ('g1', '{}');
        INSERT INTO printers (id, name, kind, role) VALUES ('pr1', 'Kitchen', 'network', 'kitchen');
        INSERT INTO product_modifier_groups (product_id, group_id) VALUES ('p1', 'g1');
        INSERT INTO category_printers (category_id, printer_id) VALUES ('c1', 'pr1');
      `)
    })

    it('rejects links to a missing parent', () => {
      const insertPmg = (p: string, g: string): void => {
        t.db.prepare('INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?, ?)').run(p, g)
      }
      const insertCp = (c: string, p: string): void => {
        t.db.prepare('INSERT INTO category_printers (category_id, printer_id) VALUES (?, ?)').run(c, p)
      }
      expect(() => insertPmg('nope', 'g1')).toThrow(/FOREIGN KEY/)
      expect(() => insertPmg('p1', 'nope')).toThrow(/FOREIGN KEY/)
      expect(() => insertCp('nope', 'pr1')).toThrow(/FOREIGN KEY/)
      expect(() => insertCp('c1', 'nope')).toThrow(/FOREIGN KEY/)
    })

    it('removes product_modifier_groups links with either parent', () => {
      t.db.exec("DELETE FROM modifier_groups WHERE id = 'g1'")
      expect(count('product_modifier_groups')).toBe(0)
      expect(count('products')).toBe(1)
    })

    it('removes product_modifier_groups links when the product goes', () => {
      t.db.exec("DELETE FROM products WHERE id = 'p1'")
      expect(count('product_modifier_groups')).toBe(0)
      expect(count('modifier_groups')).toBe(1)
    })

    it('removes category_printers links with the printer', () => {
      t.db.exec("DELETE FROM printers WHERE id = 'pr1'")
      expect(count('category_printers')).toBe(0)
      expect(count('categories')).toBe(1)
    })

    it('removes category_printers links with the category once it has no products', () => {
      t.db.exec("DELETE FROM products WHERE id = 'p1'")
      t.db.exec("DELETE FROM categories WHERE id = 'c1'")
      expect(count('category_printers')).toBe(0)
      expect(count('printers')).toBe(1)
    })
  })
})
