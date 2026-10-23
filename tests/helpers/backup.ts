import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@shared/ids'
import type { Clock } from '../../src/main/application/ports'
import { folderTarget, type BackupTarget } from '../../src/main/infrastructure/backup/targets'
import { openDatabase, type Database } from '../../src/main/infrastructure/db/connection'
import { migrate } from '../../src/main/infrastructure/db/migrate'
import { writeInstallation } from '../../src/main/infrastructure/fs/installation'
import { ensureDataLayout, type DataPaths } from '../../src/main/paths'

/** A clock that only moves when told to. */
export interface ManualClock extends Clock {
  advance(ms: number): void
  set(iso: string): void
}

export function manualClock(iso = '2026-10-22T10:00:00.000Z'): ManualClock {
  let t = new Date(iso).getTime()
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms
    },
    set: (next) => {
      t = new Date(next).getTime()
    }
  }
}

/**
 * A `schedule(fn, ms) => cancel` that runs nothing on its own: `advance(ms)` moves the clock and
 * fires the due callbacks in time order.
 */
export function manualScheduler(clock: ManualClock) {
  let seq = 0
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    schedule(fn: () => void, ms: number): () => void {
      const id = ++seq
      timers.set(id, { due: clock.now().getTime() + Math.max(0, ms), fn })
      return () => {
        timers.delete(id)
      }
    },
    advance(ms: number): void {
      const target = clock.now().getTime() + ms
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
        if (!next) break
        timers.delete(next[0])
        clock.set(new Date(Math.max(next[1].due, clock.now().getTime())).toISOString())
        next[1].fn()
      }
      clock.set(new Date(target).toISOString())
    },
    get pending(): number {
      return timers.size
    }
  }
}

export interface BackupFixture {
  dir: string
  paths: DataPaths
  db: Database
  /** A fresh empty directory (a backup disk, a NAS share, a USB mount point). */
  newDir(name: string): string
  cleanup(): void
}

/** A data directory with a migrated database, a finished installation and `products` products. */
export function backupFixture(products = 5): BackupFixture {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-backup-'))
  const paths = ensureDataLayout(join(dir, 'data'))
  writeInstallation(paths, {
    installationId: 'inst-test',
    createdAt: '2026-10-01T08:00:00.000Z',
    setupCompletedAt: '2026-10-01T09:00:00.000Z',
    appVersion: '0.1.0'
  })
  const db = openDatabase(paths.dbFile)
  migrate(db)
  addProducts(db, products)
  return {
    dir,
    paths,
    db,
    newDir(name) {
      return mkdtempSync(join(dir, `${name}-`))
    },
    cleanup() {
      if (db.open) db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Inserts `n` products (and their category the first time). */
export function addProducts(db: Database, n: number): void {
  let category = (db.prepare('SELECT id FROM categories LIMIT 1').get() as { id: string } | undefined)?.id
  if (!category) {
    category = newId()
    db.prepare('INSERT INTO categories (id, name_json, color) VALUES (?, ?, ?)').run(category, '{"fr":"Boissons"}', '#0FA3A3')
  }
  const insert = db.prepare('INSERT INTO products (id, category_id, name_json, price_cents, vat_bp) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < n; i++) insert.run(newId(), category, `{"fr":"Produit ${i}"}`, 1500, 2000)
}

export const countProducts = (db: Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n

/** Writes `<root>/AtlasBackup/.atlas-target` with `key`, as the setup "Tester" does. */
export function writeMarker(root: string, key: string): void {
  mkdirSync(join(root, 'AtlasBackup'), { recursive: true })
  writeFileSync(join(root, 'AtlasBackup', '.atlas-target'), `${key}\n`)
}

/** A disk/NAS folder target whose folder is already marked (key `key-<id>`). */
export function markedFolder(def: { id: string; role: 'disk' | 'nas'; path: string; label?: string }): BackupTarget {
  writeMarker(def.path, `key-${def.id}`)
  return folderTarget({ ...def, targetKey: `key-${def.id}` })
}
