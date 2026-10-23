import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabaseReadOnly, type Database } from '../../../infrastructure/db/connection'
import { migrations } from '../../../infrastructure/db/migrate'
import { readInstallation } from '../../../infrastructure/fs/installation'
import type { DataPaths } from '../../../paths'
import type { Clock } from '../../ports'

export type StartupState = 'needs-setup' | 'ok' | 'recovered' | 'corrupt' | 'newer-schema'

export interface RestoredOrder {
  id: string
  /** The table label, else the order number, else "Vente" + the end of the id. */
  label: string
}

export interface StartupReport {
  state: StartupState
  /** The previous run did not quit cleanly (`running.lock` was left behind). */
  unclean: boolean
  /** `failed` only for `corrupt`, and for a `newer-schema` database that also fails the check. */
  integrity: 'ok' | 'failed'
  /** Orders still `open` or `parked`; filled for `recovered` only. */
  restoredOrders: RestoredOrder[]
  /** The latest backup that succeeded on at least one destination, or null. */
  lastBackupAt: string | null
  /** `corrupt`: where the damaged database was moved to (null if there was no file to move). */
  corruptFile: string | null
  /** `newer-schema`: the database was written by a newer app. */
  newerSchema: { found: number; supported: number } | null
}

export type StartupLog = (event: string, data?: Record<string, unknown>) => void

export interface StartupDeps {
  paths: DataPaths
  clock: Clock
  /** `acquireRunningLock(paths).wasUnclean`. */
  unclean: boolean
  log?: StartupLog
}

/**
 * The start-up decision, taken before the application opens the database for writing:
 * 1. `needs-setup`: no `installation.json`, or its setup never completed. The database is not looked at.
 * 2. The database must exist, hold a schema, and pass `PRAGMA quick_check`, then the full
 *    `integrity_check` if that fails. Otherwise (damaged, not a database, empty or missing)
 *    the state is `corrupt`: the file and its `-wal`/`-shm` are moved to `db/corrupt-<ts>.db*`, so
 *    nothing is deleted and the next step is a restore from a backup.
 * 3. A database whose `user_version` is newer than the migrations this app knows is `newer-schema`.
 *    It is never written to and never moved, whatever else is true of it.
 * 4. A healthy database is `recovered` after an unclean shutdown (listing the open and parked
 *    orders), `ok` otherwise.
 * The database is only ever opened read-only here; the caller opens it for writing and migrates
 * afterwards. A failure that does not prove corruption (busy, permissions, I/O) is thrown, never
 * treated as corruption: moving a healthy database aside is worse than failing to start.
 */
export function startupCheck(deps: StartupDeps): StartupReport {
  const { paths, clock, unclean } = deps
  const log = deps.log ?? (() => {})
  const report = (state: StartupState, extra: Partial<StartupReport> = {}): StartupReport => ({
    state,
    unclean,
    integrity: 'ok',
    restoredOrders: [],
    lastBackupAt: null,
    corruptFile: null,
    newerSchema: null,
    ...extra
  })
  const corrupt = (reason: string): StartupReport => {
    const corruptFile = quarantine(paths, clock)
    log('startup.db_quarantined', { reason, from: paths.dbFile, to: corruptFile })
    return report('corrupt', { integrity: 'failed', corruptFile })
  }

  if (!readInstallation(paths)?.setupCompletedAt) return report('needs-setup')
  if (!existsSync(paths.dbFile)) return corrupt('missing')

  let inspected: Inspection
  try {
    inspected = inspect(paths.dbFile, unclean, log)
  } catch (error) {
    if (!isCorruptionError(error)) throw error
    log('startup.integrity_failed', { problems: [(error as Error).message] })
    return corrupt((error as Error).message)
  }

  switch (inspected.kind) {
    case 'corrupt':
      return corrupt(inspected.reason)
    case 'newer':
      return report('newer-schema', {
        integrity: inspected.integrity,
        newerSchema: { found: inspected.found, supported: migrations.length }
      })
    case 'readable':
      return report(unclean ? 'recovered' : 'ok', {
        restoredOrders: inspected.restoredOrders,
        lastBackupAt: inspected.lastBackupAt
      })
  }
}

type Inspection =
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; found: number; integrity: 'ok' | 'failed' }
  | { kind: 'readable'; restoredOrders: RestoredOrder[]; lastBackupAt: string | null }

/** Reads the database and closes it; throws SQLite errors (see `isCorruptionError`). */
function inspect(file: string, unclean: boolean, log: StartupLog): Inspection {
  const db = openDatabaseReadOnly(file)
  try {
    const version = db.pragma('user_version', { simple: true }) as number
    if (version > migrations.length) {
      // Reported, never acted on: a newer database may use things this check does not know.
      let integrity: 'ok' | 'failed'
      try {
        integrity = integrityProblems(db, log).length === 0 ? 'ok' : 'failed'
      } catch (error) {
        if (!isCorruptionError(error)) throw error
        integrity = 'failed'
      }
      return { kind: 'newer', found: version, integrity }
    }

    const problems = integrityProblems(db, log)
    if (problems.length > 0) return { kind: 'corrupt', reason: problems[0] ?? 'integrity_check' }
    if (version < 1) return { kind: 'corrupt', reason: 'no schema' }

    return {
      kind: 'readable',
      restoredOrders: unclean ? readOpenOrders(db) : [],
      lastBackupAt: readLastBackupAt(db)
    }
  } finally {
    db.close()
  }
}

/** Messages of `quick_check`, then of `integrity_check` if that failed; empty when the database is sound. */
function integrityProblems(db: Database, log: StartupLog): string[] {
  const quick = runCheck(db, 'quick_check')
  if (quick.length === 0) return []
  log('startup.integrity_failed', { check: 'quick_check', problems: quick.slice(0, 10) })
  const full = runCheck(db, 'integrity_check')
  if (full.length > 0) log('startup.integrity_failed', { check: 'integrity_check', problems: full.slice(0, 10) })
  return full
}

function runCheck(db: Database, pragma: 'quick_check' | 'integrity_check'): string[] {
  const rows = db.pragma(pragma) as Record<string, string>[]
  const messages = rows.map((row) => row[pragma] ?? '')
  return messages.length === 1 && messages[0] === 'ok' ? [] : messages
}

function readOpenOrders(db: Database): RestoredOrder[] {
  const rows = db
    .prepare(
      `SELECT o.id AS id, o.order_number AS orderNumber, t.label AS tableLabel
       FROM orders o LEFT JOIN tables t ON t.id = o.table_id
       WHERE o.status IN ('open', 'parked')
       ORDER BY o.opened_at, o.id`
    )
    .all() as { id: string; orderNumber: number | null; tableLabel: string | null }[]
  return rows.map((row) => ({
    id: row.id,
    // The end of a UUIDv7 is random; its start is the timestamp, shared by orders opened within a minute.
    label: row.tableLabel ?? (row.orderNumber !== null ? String(row.orderNumber) : `Vente ${row.id.slice(-6)}`)
  }))
}

/**
 * Newest `backup_runs.at` with at least one result `{ ok: true }` in `results_json` (a JSON array,
 * one entry per destination). A row whose results cannot be read counts as not successful.
 */
function readLastBackupAt(db: Database): string | null {
  const rows = db.prepare('SELECT at, results_json AS results FROM backup_runs ORDER BY at DESC').iterate() as Iterable<{
    at: string
    results: string
  }>
  for (const row of rows) {
    try {
      const results: unknown = JSON.parse(row.results)
      if (Array.isArray(results) && results.some((r) => (r as { ok?: unknown } | null)?.ok === true)) return row.at
    } catch {
      // Unreadable results: not a success.
    }
  }
  return null
}

/** SQLite's own verdict that the file is damaged (as opposed to busy, unreadable, out of space...). */
function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(code)
}

/**
 * Moves the database and its `-wal`/`-shm` files to `db/corrupt-<ts>.db*`, the database first: a
 * crash half way leaves a missing database (reported as corrupt next time), never a database
 * silently stripped of its WAL. Returns the new database path, or null if there was no database file.
 */
function quarantine(paths: DataPaths, clock: Clock): string | null {
  const stamp = clock.now().toISOString().replace(/[-:.]/g, '')
  const target = join(paths.db, `corrupt-${stamp}.db`)
  let moved = false
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${paths.dbFile}${suffix}`
    if (!existsSync(from)) continue
    renameSync(from, `${target}${suffix}`)
    if (suffix === '') moved = true
  }
  return moved ? target : null
}
