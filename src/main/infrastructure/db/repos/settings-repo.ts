import { isDeepStrictEqual } from 'node:util'
import { AppErrorException } from '../../../application/errors'
import {
  SETTINGS,
  SETTING_KEYS,
  defaultOf,
  isSettingKey,
  type SettingKey,
  type SettingValue,
  type SettingsValues
} from '../../../domain/config/settings-registry'
import type { Database } from '../connection'
import { appendEvent } from '../event-log'
import type { Tx } from '../uow'

export interface SettingsRepo {
  /** The stored value, or the registry default when the setting was never set. */
  get<K extends SettingKey>(key: K): SettingValue<K>
  /**
   * Validates, stores, writes the `event_log` row and pushes `settings.changed` (published once
   * the transaction commits). A value equal to the stored one writes nothing (a value that was never
   * stored is always written, even when it equals the default: profiles export stored values). Throws `invalid_input` (`params.field` = the offending path) and
   * writes nothing when the value does not satisfy the registry schema.
   * Who may call it is the use case's business: the repo does not check permissions.
   */
  set<K extends SettingKey>(tx: Tx, key: K, value: SettingValue<K>, userId?: string): void
  /** Every registry key, stored value over default. */
  all(): SettingsValues
}

/** Secrets are stored but their value never reaches the audit trail. */
const REDACTED_IN_LOG: readonly SettingKey[] = ['tech.codeHash']

export function createSettingsRepo(db: Database): SettingsRepo {
  const read = (key: SettingKey, valueJson: string): unknown => {
    let parsed: unknown
    try {
      parsed = JSON.parse(valueJson)
    } catch {
      throw new AppErrorException('setting_corrupt', { key })
    }
    const checked = SETTINGS[key].schema.safeParse(parsed)
    if (!checked.success) throw new AppErrorException('setting_corrupt', { key })
    return checked.data
  }

  const get = <K extends SettingKey>(key: K): SettingValue<K> => {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
    return (row ? read(key, row.value_json) : defaultOf(key)) as SettingValue<K>
  }

  return {
    get,

    set(tx, key, value, userId) {
      const checked = SETTINGS[key].schema.safeParse(value)
      if (!checked.success) {
        const issue = checked.error.issues[0]
        const field = [key, ...(issue?.path ?? [])].join('.')
        throw new AppErrorException('invalid_input', { field, reason: issue?.message })
      }
      const row = tx.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
        | { value_json: string }
        | undefined
      // A stored value that no longer reads back must stay replaceable, or it could never be repaired.
      let stored: unknown
      let readable = false
      if (row) {
        try {
          stored = read(key, row.value_json)
          readable = true
        } catch {
          // handled below: written over
        }
      }
      // Saving what is already stored is not a change: no row, no audit entry, no event.
      if (readable && isDeepStrictEqual(stored, checked.data)) return
      const previous = row ? stored : defaultOf(key)
      tx.db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
        )
        .run(key, JSON.stringify(checked.data), tx.clock.now().toISOString())
      appendEvent(
        tx.db,
        {
          type: 'settings.changed',
          entity: 'setting',
          entityId: key,
          ...(userId === undefined ? {} : { userId }),
          data: REDACTED_IN_LOG.includes(key) ? { redacted: true } : { from: previous, to: checked.data }
        },
        tx.clock
      )
      tx.events.push({ type: 'settings.changed', keys: [key] })
    },

    all() {
      const stored = new Map(
        (db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[])
          .filter((row) => isSettingKey(row.key))
          .map((row) => [row.key, row.value_json])
      )
      const out: Record<string, unknown> = {}
      for (const key of SETTING_KEYS) {
        const valueJson = stored.get(key)
        out[key] = valueJson === undefined ? defaultOf(key) : read(key, valueJson)
      }
      return out as SettingsValues
    }
  }
}
