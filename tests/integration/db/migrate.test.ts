import { readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, migrations, type Migration } from '../../../src/main/infrastructure/db/migrate'
import { tempDb, type TempDb } from '../../helpers/db'

const TABLES = [
  'settings', 'event_log', 'sequences', 'profiles', 'users', 'categories', 'products',
  'modifier_groups', 'modifiers', 'product_modifier_groups', 'menus', 'menu_courses',
  'menu_course_items', 'rooms', 'tables', 'printers', 'category_printers', 'payment_methods',
  'customers', 'business_days', 'orders', 'order_lines', 'payments', 'tickets', 'invoices',
  'z_reports', 'print_jobs', 'backup_destinations', 'backup_runs'
]

const userVersion = (t: TempDb): number => t.db.pragma('user_version', { simple: true }) as number
const tableNames = (t: TempDb): string[] =>
  (
    t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name)

describe('migrate', () => {
  let t: TempDb
  afterEach(() => t.cleanup())

  it('brings an empty database to user_version 1', () => {
    t = tempDb({ migrate: false })
    expect(userVersion(t)).toBe(0)
    expect(migrate(t.db)).toEqual({ from: 0, to: 1 })
    expect(userVersion(t)).toBe(1)
  })

  it('creates every table of schema v1', () => {
    t = tempDb()
    expect(tableNames(t).sort()).toEqual([...TABLES].sort())
  })

  it('is idempotent and keeps existing data', () => {
    t = tempDb()
    t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('k', '1', 'now')").run()
    expect(migrate(t.db)).toEqual({ from: 1, to: 1 })
    expect(userVersion(t)).toBe(1)
    expect(t.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 })
  })

  it('registers every migrations/NNN_*.sql file, in order, with its content', () => {
    const dir = new URL('../../../src/main/infrastructure/db/migrations/', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(migrations.map((m) => `${m.name}.sql`)).toEqual(files)
    expect(migrations.map((m) => m.version)).toEqual(files.map((_, i) => i + 1))
    for (const m of migrations) expect(m.sql.length).toBeGreaterThan(0)
  })

  describe('with a custom list', () => {
    const m1: Migration = { version: 1, name: '001_a', sql: 'CREATE TABLE a (x INTEGER);' }
    const m2: Migration = { version: 2, name: '002_b', sql: 'CREATE TABLE b (x INTEGER);' }

    it('applies only the pending migrations, in order', () => {
      t = tempDb({ migrate: false })
      expect(migrate(t.db, [m1])).toEqual({ from: 0, to: 1 })
      // m1 would fail if it ran again (no IF NOT EXISTS).
      expect(migrate(t.db, [m1, m2])).toEqual({ from: 1, to: 2 })
      expect(userVersion(t)).toBe(2)
      expect(tableNames(t).sort()).toEqual(['a', 'b'])
    })

    it('runs each file in one transaction: a failing file leaves no trace and no version bump', () => {
      t = tempDb({ migrate: false })
      migrate(t.db, [m1])
      const bad: Migration = {
        version: 2,
        name: '002_bad',
        sql: 'CREATE TABLE b (x INTEGER); INSERT INTO does_not_exist VALUES (1);'
      }
      expect(() => migrate(t.db, [m1, bad])).toThrow(/does_not_exist/)
      expect(userVersion(t)).toBe(1)
      expect(tableNames(t)).toEqual(['a'])
      expect(t.db.inTransaction).toBe(false)
    })

    it('rejects a list that does not number 1, 2, 3, … without gaps', () => {
      t = tempDb({ migrate: false })
      expect(() => migrate(t.db, [m2])).toThrow(/migration/)
      expect(() => migrate(t.db, [m1, { ...m2, version: 3 }])).toThrow(/migration/)
      expect(userVersion(t)).toBe(0)
    })
  })
})
