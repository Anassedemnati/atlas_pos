import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

describe('better-sqlite3 toolchain smoke', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('opens an in-memory database and runs a query', () => {
    const db = new Database(':memory:')
    try {
      const row = db.prepare('select 1 as one').get() as { one: number }
      expect(row.one).toBe(1)
    } finally {
      db.close()
    }
  })

  it('round-trips the WAL journal mode on a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-smoke-'))
    tempDirs.push(dir)
    const db = new Database(join(dir, 'smoke.db'))
    try {
      expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    } finally {
      db.close()
    }
  })
})
