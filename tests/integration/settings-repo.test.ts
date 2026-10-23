import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../src/main/application/events'
import type { DomainEvent } from '../../src/main/application/events'
import { AppErrorException } from '../../src/main/application/errors'
import { SETTING_KEYS, defaultOf } from '../../src/main/domain/config/settings-registry'
import { createSettingsRepo, type SettingsRepo } from '../../src/main/infrastructure/db/repos/settings-repo'
import { createUnitOfWork, type UnitOfWork } from '../../src/main/infrastructure/db/uow'
import { fixedClock } from '../helpers/clock'
import { tempDb, type TempDb } from '../helpers/db'

const legal = {
  raisonSociale: 'Café Atlas SARL',
  nomCommercial: 'Café Atlas',
  adresse: '12 avenue Hassan II',
  ville: 'Casablanca',
  telephone: '0522000000',
  ice: '001234567000012',
  if: '12345678',
  rc: '123456',
  patente: '31234567'
}

describe('settings repo', () => {
  let t: TempDb
  let repo: SettingsRepo
  let uow: UnitOfWork
  let published: DomainEvent[]

  beforeEach(() => {
    t = tempDb()
    const bus = createEventBus()
    published = []
    bus.subscribe('settings.changed', (e) => published.push(e))
    uow = createUnitOfWork(t.db, fixedClock('2026-10-22T10:30:00.000Z'), bus)
    repo = createSettingsRepo(t.db)
  })
  afterEach(() => t.cleanup())

  const eventRows = (): Record<string, unknown>[] =>
    t.db.prepare('SELECT * FROM event_log ORDER BY id').all() as Record<string, unknown>[]

  it('returns the default of a setting that was never set', () => {
    expect(repo.get('till.autoLockSeconds')).toBe(120)
    expect(repo.get('vat.rates')).toEqual([2000, 1400, 1000, 700, 0])
    expect(t.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('does not let a caller mutate the default through the returned value', () => {
    repo.get('vat.rates').push(1)
    expect(repo.get('vat.rates')).toEqual([2000, 1400, 1000, 700, 0])
  })

  it('stores a value and reads it back', () => {
    uow.run((tx) => repo.set(tx, 'till.autoLockSeconds', 45))
    uow.run((tx) => repo.set(tx, 'business.legal', legal))
    expect(repo.get('till.autoLockSeconds')).toBe(45)
    expect(repo.get('business.legal')).toEqual(legal)
    expect(t.db.prepare("SELECT value_json, updated_at FROM settings WHERE key = 'till.autoLockSeconds'").get()).toEqual({
      value_json: '45',
      updated_at: '2026-10-22T10:30:00.000Z'
    })
  })

  it('overwrites a value (one row per key)', () => {
    uow.run((tx) => repo.set(tx, 'receipt.footer', 'Au revoir'))
    uow.run((tx) => repo.set(tx, 'receipt.footer', 'À demain'))
    expect(repo.get('receipt.footer')).toBe('À demain')
    expect(t.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 })
  })

  it('writes an event_log row with the previous and the new value', () => {
    uow.run((tx) => repo.set(tx, 'receipt.lang', 'ar', 'user-1'))
    expect(eventRows()).toEqual([
      {
        id: 1,
        at: '2026-10-22T10:30:00.000Z',
        type: 'settings.changed',
        entity: 'setting',
        entity_id: 'receipt.lang',
        user_id: 'user-1',
        data_json: '{"from":"fr","to":"ar"}'
      }
    ])
    uow.run((tx) => repo.set(tx, 'receipt.lang', 'en'))
    expect(eventRows()[1]).toMatchObject({ user_id: null, data_json: '{"from":"ar","to":"en"}' })
  })

  it('never writes the technician code hash to the event log', () => {
    uow.run((tx) => repo.set(tx, 'tech.codeHash', 'scrypt$SECRET-HASH'))
    expect(repo.get('tech.codeHash')).toBe('scrypt$SECRET-HASH')
    const row = eventRows()[0]!
    expect(row['entity_id']).toBe('tech.codeHash')
    expect(JSON.stringify(row)).not.toContain('SECRET-HASH')
  })

  it('pushes settings.changed, published only after the commit', () => {
    uow.run((tx) => {
      repo.set(tx, 'receipt.lang', 'ar')
      repo.set(tx, 'ui.ticketSide', 'end')
      expect(published).toEqual([])
    })
    expect(published).toEqual([
      { type: 'settings.changed', keys: ['receipt.lang'] },
      { type: 'settings.changed', keys: ['ui.ticketSide'] }
    ])
  })

  const thrownBy = (fn: () => void): unknown => {
    try {
      fn()
    } catch (error) {
      return error
    }
    return undefined
  }

  it('rejects an invalid value without writing anything', () => {
    const error = thrownBy(() => uow.run((tx) => repo.set(tx, 'business.legal', { ...legal, ice: '00123456700001' })))
    expect(error).toBeInstanceOf(AppErrorException)
    expect(error).toMatchObject({
      code: 'invalid_input',
      messageKey: 'errors.invalid_input',
      params: { field: 'business.legal.ice' }
    })
    expect(t.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
    expect(eventRows()).toEqual([])
    expect(published).toEqual([])
  })

  it('names the setting itself as the field when the whole value is wrong', () => {
    // @ts-expect-error not a language
    const error = thrownBy(() => uow.run((tx) => repo.set(tx, 'receipt.lang', 'es')))
    expect(error).toBeInstanceOf(AppErrorException)
    expect(error).toMatchObject({ code: 'invalid_input', params: { field: 'receipt.lang' } })
  })

  it('rolls the setting, its event row and its event back together with the transaction', () => {
    expect(() =>
      uow.run((tx) => {
        repo.set(tx, 'receipt.lang', 'ar')
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(repo.get('receipt.lang')).toBe('fr')
    expect(eventRows()).toEqual([])
    expect(published).toEqual([])
  })

  it('all() merges stored values over the defaults, for every key', () => {
    uow.run((tx) => repo.set(tx, 'backup.retentionDays', 7))
    const all = repo.all()
    expect(all['backup.retentionDays']).toBe(7)
    expect(all['backup.warnAfterHours']).toBe(24)
    expect(all['business.legal']).toEqual(defaultOf('business.legal'))
    expect(Object.keys(all).sort()).toEqual([...SETTING_KEYS].sort())
  })

  it('ignores a stored key the registry no longer knows', () => {
    t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('old.key', '1', 'x')").run()
    expect(Object.keys(repo.all())).not.toContain('old.key')
  })

  it('refuses to hand out a stored value that no longer satisfies its schema', () => {
    t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('day.cutoverHour', '99', 'x')").run()
    expect(() => repo.get('day.cutoverHour')).toThrowError(AppErrorException)
    t.db.prepare("UPDATE settings SET value_json = '{not json' WHERE key = 'day.cutoverHour'").run()
    expect(() => repo.get('day.cutoverHour')).toThrow(/setting_corrupt/)
  })

  it('lets a corrupt stored value be replaced', () => {
    t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('day.cutoverHour', '{not json', 'x')").run()
    uow.run((tx) => repo.set(tx, 'day.cutoverHour', 4))
    expect(repo.get('day.cutoverHour')).toBe(4)
    expect(eventRows()[0]).toMatchObject({ data_json: '{"to":4}' })
  })
})
