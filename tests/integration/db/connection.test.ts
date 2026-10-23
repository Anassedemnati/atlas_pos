import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/infrastructure/db/connection'
import { DatabaseError } from '../../../src/main/infrastructure/db/errors'
import { tempDb, type TempDb } from '../../helpers/db'

describe('openDatabase', () => {
  let t: TempDb | undefined
  const dirs: string[] = []
  afterEach(() => {
    t?.cleanup()
    t = undefined
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const caught = (fn: () => unknown): unknown => {
    try {
      fn()
    } catch (error) {
      return error
    }
    throw new Error('expected the call to throw')
  }

  it('applies the global pragmas', () => {
    t = tempDb({ migrate: false })
    expect(t.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(t.db.pragma('synchronous', { simple: true })).toBe(2) // FULL
    expect(t.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(t.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    // Needed so that INSERT OR REPLACE fires the DELETE triggers (immutability).
    expect(t.db.pragma('recursive_triggers', { simple: true })).toBe(1)
  })

  it('refuses a database that cannot use WAL, and closes the handle', () => {
    const close = vi.spyOn(BetterSqlite3.prototype, 'close')
    // An in-memory database reports journal_mode=memory.
    const error = caught(() => openDatabase(':memory:'))
    expect(error).toBeInstanceOf(DatabaseError)
    expect(error).toMatchObject({ code: 'wal_unavailable', messageKey: 'errors.wal_unavailable' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the handle when a pragma step throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-db-'))
    dirs.push(dir)
    const file = join(dir, 'garbage.db')
    writeFileSync(file, 'this is not a sqlite database, '.repeat(20))
    const close = vi.spyOn(BetterSqlite3.prototype, 'close')
    expect(() => openDatabase(file)).toThrow(/not a database/)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
