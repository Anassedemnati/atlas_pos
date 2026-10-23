import { afterEach, describe, expect, it } from 'vitest'
import { tempDb, type TempDb } from '../../helpers/db'

describe('openDatabase', () => {
  let t: TempDb
  afterEach(() => t.cleanup())

  it('applies the global pragmas', () => {
    t = tempDb({ migrate: false })
    expect(t.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(t.db.pragma('synchronous', { simple: true })).toBe(2) // FULL
    expect(t.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(t.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  })
})
