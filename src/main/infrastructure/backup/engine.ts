import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { newId } from '@shared/ids'
import type { AppError } from '@shared/result'
import type { Clock, EventBus } from '../../application/ports'
import type { DataPaths } from '../../paths'
import type { Database } from '../db/connection'
import type { SettingsRepo } from '../db/repos/settings-repo'
import { readJsonSafe } from '../fs/atomic'
import { readInstallation } from '../fs/installation'
import { fullBackupName, rotateDir } from './rotation'
import { createSnapshot, manifestPath, ManifestSchema, type BackupKind, type Snapshot } from './snapshot'
import { copyFileAtomic, ensureSubdir, fsyncDir, renameWithRetry, type BackupTarget, type TargetRole } from './targets'
import { BACKUP_DIR } from './usb-scan'

export type FullKind = Exclude<BackupKind, 'live'>

/** The rolling live copy, in `AtlasBackup/live/` on each target and in `dataDir/backups/live/`. */
export const LIVE_FILE_NAME = 'atlas-live.atlasbak'

/** One entry of `backup_runs.results_json` (a JSON array, one entry per destination). */
export interface TargetResult {
  targetId: string
  role: TargetRole
  ok: boolean
  /** An errno code (`ENOSPC`...), or `unavailable` when the destination was not there. */
  error?: string
  /** Where the copy was written. */
  file?: string
}

export type BackupRunResult =
  | {
      ok: true
      runId: string
      kind: FullKind
      at: string
      fileName: string
      sha256: string
      bytes: number
      /** The copy kept in `dataDir/backups/`. */
      localFile: string
      results: TargetResult[]
    }
  /** No snapshot could be taken or stored locally: nothing was copied anywhere. */
  | { ok: false; kind: FullKind; at: string; error: AppError }

export type TargetState = 'ok' | 'pending' | 'warning' | 'error'

export interface TargetStatus {
  id: string
  role: TargetRole
  lastOkAt: string | null
  lastError: string | null
  state: TargetState
}

export interface BackupStatus {
  /** The newest successful copy to any destination. */
  lastOkAt: string | null
  perTarget: TargetStatus[]
  overall: 'ok' | 'warning' | 'error'
}

export type BackupLog = (event: string, data?: Record<string, unknown>) => void

/** `setTimeout` as a function returning its own cancel, so tests can drive time. */
export type Schedule = (fn: () => void, ms: number) => () => void

export interface BackupIo {
  /** Copies `src` over `dest` atomically (asynchronous: never blocks the till). */
  copyFile(src: string, dest: string): Promise<void>
}

export interface BackupEngineDeps {
  db: Database
  paths: DataPaths
  /** The destinations as configured right now (read on each run). */
  targets: () => BackupTarget[]
  clock: Clock
  settings: Pick<SettingsRepo, 'get'>
  log: BackupLog
  eventBus: EventBus
  appVersion: string
  schedule?: Schedule
  io?: BackupIo
  /** Minimum spacing of live copies, and how long a ticket close waits for others to join it. Default 60 s. */
  liveMinIntervalMs?: number
  /** How often `start()` retries the destinations that missed a copy. Default 60 s. */
  retryIntervalMs?: number
}

export interface BackupEngine {
  /**
   * Asks for a live copy. The first close of a quiet period schedules one `liveMinIntervalMs` later;
   * every close until then is in it, and a close that arrives while it runs schedules one more. At
   * most one live copy per interval. Never throws and never waits for I/O.
   */
  onTicketClosed(): void
  /**
   * A dated, verified copy in `AtlasBackup/full/` on every available destination plus one in
   * `dataDir/backups/`, then rotation. `label` ends the file name (`Z12`). Never rejects: per
   * destination failures are in `results`, and a snapshot that could not be taken is `ok: false`.
   */
  runFull(kind: FullKind, label?: string): Promise<BackupRunResult>
  /** Copies the newest full and the newest live copy to the destinations that missed them. Never rejects. */
  retryPending(): Promise<void>
  status(): BackupStatus
  /** Purges leftover temp files, then retries every `retryIntervalMs` (first run right away). */
  start(): void
  /** Cancels the timers (a scheduled live copy is dropped); work already running finishes, see `idle()`. */
  stop(): void
  /** Resolves when no backup work is running or queued. */
  idle(): Promise<void>
}

const DEFAULT_INTERVAL_MS = 60_000
const HOUR_MS = 60 * 60 * 1000

const defaultSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'copy_failed'
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

interface RunRow {
  id: string
  fileName: string
  sha256: string
  results: string
}

/** A run's `results_json`; unreadable content counts as "nothing delivered". */
function parseResults(json: string): TargetResult[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? (value as TargetResult[]) : []
  } catch {
    return []
  }
}

interface TargetMemory {
  lastOkAt: string | null
  lastError: string | null
  /** When this engine first saw the target: the age reference while it has never succeeded. */
  firstSeenAt: string
}

export function createBackupEngine(deps: BackupEngineDeps): BackupEngine {
  const { db, paths, clock, settings, log, eventBus } = deps
  const schedule = deps.schedule ?? defaultSchedule
  const io: BackupIo = deps.io ?? { copyFile: copyFileAtomic }
  const liveInterval = deps.liveMinIntervalMs ?? DEFAULT_INTERVAL_MS
  const retryInterval = deps.retryIntervalMs ?? DEFAULT_INTERVAL_MS
  const tmpDir = join(paths.backups, 'tmp')
  const localLiveDir = join(paths.backups, 'live')

  const memory = new Map<string, TargetMemory>()
  let queue: Promise<void> = Promise.resolve()
  let stopped = false
  let started = false
  let cancelLive: (() => void) | null = null
  let cancelRetry: (() => void) | null = null
  let liveQueued = false
  let liveRunning = false
  let liveDirty = false
  let lastPublished: BackupStatus['overall'] | null = null

  /** Runs `op` after everything queued before it: live, full and retry never touch the same files at once. */
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const now = (): string => clock.now().toISOString()

  const listTargets = (): BackupTarget[] => {
    try {
      return deps.targets()
    } catch (error) {
      log('backup.targets_failed', { message: errorMessage(error) })
      return []
    }
  }

  const memoryOf = (target: BackupTarget): TargetMemory => {
    let m = memory.get(target.id)
    if (!m) {
      let row: { lastOkAt: string | null; lastError: string | null } | undefined
      try {
        row = db
          .prepare('SELECT last_ok_at AS lastOkAt, last_error AS lastError FROM backup_destinations WHERE id = ?')
          .get(target.id) as typeof row
      } catch {
        row = undefined
      }
      m = { lastOkAt: row?.lastOkAt ?? null, lastError: row?.lastError ?? null, firstSeenAt: now() }
      memory.set(target.id, m)
    }
    return m
  }

  /** Stores a destination's outcome so the status survives a restart. A target without a row is in memory only. */
  const persist = (targetId: string, m: TargetMemory): void => {
    try {
      db.prepare('UPDATE backup_destinations SET last_ok_at = ?, last_error = ? WHERE id = ?').run(
        m.lastOkAt,
        m.lastError,
        targetId
      )
    } catch (error) {
      log('backup.persist_failed', { targetId, message: errorMessage(error) })
    }
  }

  /** Copies `localFile` and its manifest to `<root>/AtlasBackup/<sub>/<name>` on one destination. */
  const copyTo = async (target: BackupTarget, localFile: string, sub: 'live' | 'full', name: string): Promise<TargetResult> => {
    const m = memoryOf(target)
    const base = { targetId: target.id, role: target.role }
    let root: string | null = null
    try {
      root = await target.resolveRoot()
    } catch (error) {
      log('backup.resolve_failed', { targetId: target.id, message: errorMessage(error) })
    }
    if (!root) {
      // Not there (unplugged, unmounted): pending, not an error.
      if (m.lastError !== null) {
        m.lastError = null
        persist(target.id, m)
      }
      return { ...base, ok: false, error: 'unavailable' }
    }
    try {
      const dest = join(await ensureSubdir(root, BACKUP_DIR, sub), name)
      // The archive first, the manifest last: a listing only sees finished copies.
      await io.copyFile(localFile, dest)
      await io.copyFile(manifestPath(localFile), manifestPath(dest))
      m.lastOkAt = now()
      m.lastError = null
      persist(target.id, m)
      return { ...base, ok: true, file: dest }
    } catch (error) {
      const code = errorCode(error)
      m.lastError = code
      persist(target.id, m)
      log('backup.copy_failed', { targetId: target.id, role: target.role, sub, name, error: code, message: errorMessage(error) })
      return { ...base, ok: false, error: code }
    }
  }

  const copyToAll = (targets: BackupTarget[], localFile: string, sub: 'live' | 'full', name: string): Promise<TargetResult[]> =>
    Promise.all(targets.map((t) => copyTo(t, localFile, sub, name)))

  const newestRun = (live: boolean): RunRow | undefined =>
    db
      .prepare(
        `SELECT id, file_name AS fileName, sha256, results_json AS results FROM backup_runs
         WHERE kind ${live ? "= 'live'" : "<> 'live'"} ORDER BY at DESC, rowid DESC LIMIT 1`
      )
      .get() as RunRow | undefined

  /**
   * The newest full and live runs, read once (`backup_runs` gains a row a minute and has no index
   * for this query: ~100 ms at 200k rows) and then kept up to date by `recordRun` and `catchUp`,
   * the only writers. `status()` runs after every copy and on every tick, so it must stay cheap.
   */
  let latest: { full: RunRow | undefined; live: RunRow | undefined } | null = null
  const latestRuns = (): { full: RunRow | undefined; live: RunRow | undefined } => {
    latest ??= { full: newestRun(false), live: newestRun(true) }
    return latest
  }

  const recordRun = (kind: BackupKind, at: string, fileName: string, snap: Snapshot, results: TargetResult[]): string => {
    const id = newId()
    const json = JSON.stringify(results)
    try {
      db.prepare(
        'INSERT INTO backup_runs (id, at, kind, file_name, sha256, bytes, results_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, at, kind, fileName, snap.sha256, snap.bytes, json)
      if (latest) latest[kind === 'live' ? 'live' : 'full'] = { id, fileName, sha256: snap.sha256, results: json }
    } catch (error) {
      log('backup.record_failed', { kind, fileName, message: errorMessage(error) })
    }
    return id
  }

  const rotate = async (dirs: string[]): Promise<void> => {
    let retentionDays: number
    try {
      retentionDays = settings.get('backup.retentionDays')
    } catch (error) {
      log('backup.rotation_failed', { message: errorMessage(error) })
      return
    }
    for (const dir of dirs) {
      try {
        const deleted = await rotateDir(dir, clock.now(), retentionDays)
        if (deleted.length > 0) log('backup.rotated', { dir, deleted })
      } catch (error) {
        log('backup.rotation_failed', { dir, message: errorMessage(error) })
      }
    }
  }

  const snapshot = (kind: BackupKind, at: Date): Promise<Snapshot> =>
    createSnapshot(db, tmpDir, {
      kind,
      appVersion: deps.appVersion,
      installationId: readInstallation(paths)?.installationId ?? '',
      createdAt: at
    })

  /** Moves a finished snapshot (archive, then manifest) out of `tmp/` to `dest`. */
  const install = async (snap: Snapshot, dest: string): Promise<void> => {
    await renameWithRetry(snap.file, dest)
    await renameWithRetry(manifestPath(snap.file), manifestPath(dest))
    await fsyncDir(dirname(dest))
  }

  const discard = async (snap: Snapshot | null): Promise<void> => {
    if (!snap) return
    await Promise.all([rm(snap.file, { force: true }), rm(manifestPath(snap.file), { force: true })]).catch(() => {})
  }

  const status = (): BackupStatus => {
    const nowMs = clock.now().getTime()
    const warnMs = settings.get('backup.warnAfterHours') * HOUR_MS
    const { full, live } = latestRuns()
    const runs = [full, live]
    const behind = (id: string): boolean =>
      runs.some((run) => run !== undefined && !parseResults(run.results).some((r) => r.targetId === id && r.ok))

    const perTarget = listTargets().map((t): TargetStatus => {
      const m = memoryOf(t)
      let state: TargetState
      if (m.lastError) state = 'error'
      else if (nowMs - Date.parse(m.lastOkAt ?? m.firstSeenAt) > warnMs) state = 'warning'
      else if (!m.lastOkAt || behind(t.id)) state = 'pending'
      else state = 'ok'
      return { id: t.id, role: t.role, lastOkAt: m.lastOkAt, lastError: m.lastError, state }
    })
    const states = new Set(perTarget.map((t) => t.state))
    const lastOkAt = perTarget.reduce<string | null>((max, t) => (t.lastOkAt && (!max || t.lastOkAt > max) ? t.lastOkAt : max), null)
    return { lastOkAt, perTarget, overall: states.has('error') ? 'error' : states.has('warning') ? 'warning' : 'ok' }
  }

  /** Announces the status after a run (`force`), or when it changed. Never throws. */
  const publishStatus = (force: boolean): void => {
    try {
      const { overall } = status()
      if (!force && overall === lastPublished) return
      lastPublished = overall
      eventBus.publish({ type: 'backup.status', status: overall })
    } catch (error) {
      log('backup.status_failed', { message: errorMessage(error) })
    }
  }

  // Live copies -----------------------------------------------------------------------------------

  const scheduleLive = (ms: number): void => {
    cancelLive = schedule(() => {
      cancelLive = null
      liveQueued = true
      void enqueue(runLive)
    }, ms)
  }

  const runLive = async (): Promise<void> => {
    liveQueued = false
    liveRunning = true
    const startedAt = clock.now()
    let snap: Snapshot | null = null
    try {
      snap = await snapshot('live', startedAt)
      await mkdir(localLiveDir, { recursive: true })
      const local = join(localLiveDir, LIVE_FILE_NAME)
      await install(snap, local)
      const results = await copyToAll(listTargets(), local, 'live', LIVE_FILE_NAME)
      recordRun('live', startedAt.toISOString(), LIVE_FILE_NAME, snap, results)
    } catch (error) {
      log('backup.live_failed', { message: errorMessage(error) })
    } finally {
      await discard(snap)
      liveRunning = false
      publishStatus(true)
      if (liveDirty && !stopped) {
        liveDirty = false
        scheduleLive(Math.max(0, startedAt.getTime() + liveInterval - clock.now().getTime()))
      }
    }
  }

  // Full copies -----------------------------------------------------------------------------------

  /** `name`, or `name` with `-2`, `-3`... when a backup of that name is already kept locally. */
  const uniqueLocalName = (name: string): string => {
    const taken = (n: string): boolean => existsSync(join(paths.backups, n)) || existsSync(manifestPath(join(paths.backups, n)))
    let candidate = name
    for (let i = 2; taken(candidate); i++) candidate = name.replace(/\.atlasbak$/, `-${i}.atlasbak`)
    return candidate
  }

  const runFullNow = async (kind: FullKind, label?: string): Promise<BackupRunResult> => {
    const at = clock.now()
    const atIso = at.toISOString()
    let snap: Snapshot | null = null
    try {
      try {
        snap = await snapshot(kind, at)
      } catch (error) {
        log('backup.snapshot_failed', { kind, message: errorMessage(error) })
        return { ok: false, kind, at: atIso, error: appError('backup_snapshot_failed', { reason: errorMessage(error) }) }
      }
      const fileName = uniqueLocalName(fullBackupName(at, kind, label))
      const localFile = join(paths.backups, fileName)
      try {
        await install(snap, localFile)
      } catch (error) {
        log('backup.local_failed', { kind, fileName, message: errorMessage(error) })
        return { ok: false, kind, at: atIso, error: appError('backup_local_failed', { reason: errorCode(error) }) }
      }
      const results = await copyToAll(listTargets(), localFile, 'full', fileName)
      const runId = recordRun(kind, atIso, fileName, snap, results)
      await rotate([paths.backups, ...results.filter((r) => r.ok && r.file).map((r) => dirname(r.file as string))])
      return { ok: true, runId, kind, at: atIso, fileName, sha256: snap.sha256, bytes: snap.bytes, localFile, results }
    } finally {
      await discard(snap)
      publishStatus(true)
    }
  }

  // Retries ---------------------------------------------------------------------------------------

  /** Delivers one run's local copy to the destinations whose entry is not `ok`, and updates its `results_json`. */
  const catchUp = async (run: RunRow, localFile: string, sub: 'live' | 'full', targets: BackupTarget[]): Promise<void> => {
    const results = parseResults(run.results)
    const missing = targets.filter((t) => !results.some((r) => r.targetId === t.id && r.ok))
    if (missing.length === 0) return
    const fresh = await copyToAll(missing, localFile, sub, run.fileName)
    const merged = [...results]
    for (const r of fresh) {
      const at = merged.findIndex((e) => e.targetId === r.targetId)
      if (at >= 0) merged[at] = r
      else merged.push(r)
    }
    const json = JSON.stringify(merged)
    if (json !== run.results) {
      db.prepare('UPDATE backup_runs SET results_json = ? WHERE id = ?').run(json, run.id)
      run.results = json // `run` is the cached row
    }
    if (sub === 'full') await rotate(fresh.filter((r) => r.ok && r.file).map((r) => dirname(r.file as string)))
  }

  const retryNow = async (): Promise<void> => {
    try {
      const targets = listTargets()
      const { full, live } = latestRuns()
      if (full) {
        const local = join(paths.backups, full.fileName)
        if (existsSync(local)) await catchUp(full, local, 'full', targets)
      }
      if (live) {
        // The local live copy may have been replaced by a newer run that was never recorded: only send it if it is this run's.
        const local = join(localLiveDir, LIVE_FILE_NAME)
        if (readJsonSafe(manifestPath(local), ManifestSchema)?.sha256 === live.sha256) {
          await catchUp(live, local, 'live', targets)
        }
      }
    } catch (error) {
      log('backup.retry_failed', { message: errorMessage(error) })
    } finally {
      publishStatus(false)
    }
  }

  const tick = (): void => {
    cancelRetry = null
    void enqueue(retryNow).finally(() => {
      if (started && !stopped && !cancelRetry) cancelRetry = schedule(tick, retryInterval)
    })
  }

  return {
    onTicketClosed() {
      try {
        if (stopped || !settings.get('backup.continuous')) return
        if (liveRunning) {
          liveDirty = true
          return
        }
        if (cancelLive || liveQueued) return
        scheduleLive(liveInterval)
      } catch (error) {
        log('backup.live_failed', { message: errorMessage(error) })
      }
    },

    runFull(kind, label) {
      return enqueue(() => runFullNow(kind, label))
    },

    retryPending() {
      return enqueue(retryNow)
    },

    status,

    start() {
      if (started) return
      started = true
      stopped = false
      void enqueue(async () => {
        // Leftovers of a snapshot interrupted by a crash or a power cut.
        try {
          for (const name of await readdir(tmpDir)) await rm(join(tmpDir, name), { force: true, recursive: true })
        } catch {
          // No tmp directory yet.
        }
      })
      cancelRetry = schedule(tick, 0)
    },

    stop() {
      stopped = true
      started = false
      cancelLive?.()
      cancelLive = null
      cancelRetry?.()
      cancelRetry = null
    },

    idle() {
      return queue
    }
  }
}

function appError(code: string, params?: Record<string, unknown>): AppError {
  return { code, messageKey: `errors.${code}`, ...(params ? { params } : {}) }
}
