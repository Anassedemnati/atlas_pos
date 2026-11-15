import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextSequence, resetSequence } from '../../../src/main/infrastructure/db/sequences'
import { tempDb, type TempDb } from '../../helpers/db'

describe('sequences', () => {
  let t: TempDb
  beforeEach(() => {
    t = tempDb()
  })
  afterEach(() => t.cleanup())

  const next = (name: string): number => t.db.transaction(() => nextSequence(t.db, name))()
  const rowCount = (): number => (t.db.prepare('SELECT count(*) AS n FROM sequences').get() as { n: number }).n

  it('starts at 1 and counts up', () => {
    expect([next('ticket'), next('ticket'), next('ticket')]).toEqual([1, 2, 3])
  })

  it('keeps one counter per name', () => {
    expect(next('ticket')).toBe(1)
    expect(next('credit')).toBe(1)
    expect(next('ticket')).toBe(2)
    expect(next('invoice-2026')).toBe(1)
  })

  it('leaves no gap when the transaction rolls back', () => {
    expect(next('ticket')).toBe(1)
    expect(() =>
      t.db.transaction(() => {
        expect(nextSequence(t.db, 'ticket')).toBe(2)
        throw new Error('boom')
      })()
    ).toThrow('boom')
    expect(next('ticket')).toBe(2)
  })

  it('leaves no row behind when the very first allocation rolls back', () => {
    expect(() =>
      t.db.transaction(() => {
        nextSequence(t.db, 'ticket')
        throw new Error('boom')
      })()
    ).toThrow('boom')
    expect(rowCount()).toBe(0)
    expect(next('ticket')).toBe(1)
  })

  it('refuses to run outside a transaction', () => {
    expect(() => nextSequence(t.db, 'ticket')).toThrow(/transaction/)
    expect(rowCount()).toBe(0)
  })

  describe('resetSequence', () => {
    it('restarts a counter so the next value is 1', () => {
      next('order-number')
      next('order-number')
      resetSequence(t.db, 'order-number')
      expect(next('order-number')).toBe(1)
    })

    it('can set the counter to a given value', () => {
      resetSequence(t.db, 'ticket', 41)
      expect(next('ticket')).toBe(42)
    })

    it('does not touch the other counters', () => {
      next('ticket')
      next('ticket')
      resetSequence(t.db, 'order-number')
      expect(next('ticket')).toBe(3)
    })
  })
})
