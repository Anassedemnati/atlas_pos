import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '@shared/ids'
import {
  startupCheck,
  type StartupLog,
  type StartupReport
} from '../../src/main/application/usecases/startup/startup-check'
import { appendEvent } from '../../src/main/infrastructure/db/event-log'
import { openDatabase, openDatabaseReadOnly, type Database } from '../../src/main/infrastructure/db/connection'
import { migrate, migrations } from '../../src/main/infrastructure/db/migrate'
import { readJsonSafe, writeFileAtomic } from '../../src/main/infrastructure/fs/atomic'
import {
  readInstallation,
  writeInstallation,
  type Installation
} from '../../src/main/infrastructure/fs/installation'
import { acquireRunningLock } from '../../src/main/lifecycle/running-lock'
import { ensureDataLayout, resolveDataDir, type DataPaths } from '../../src/main/paths'
import { fixedClock } from '../helpers/clock'

// Records the order of the durability calls and lets a test make the rename fail (a crash between
// "tmp written" and "tmp renamed"), fail a given number of times with an error code (a locked file
// on Windows), or make removing the temp file fail.
const fsTrace = vi.hoisted(() => ({
  calls: [] as string[],
  failRename: false,
  renameErrors: { code: 'EPERM', remaining: 0 },
  failRemove: false
}))
vi.mock('../../src/main/infrastructure/db/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/infrastructure/db/connection')>()
  // Passes through to the real function; a test can replace one call (a lock, an I/O error).
  return { ...actual, openDatabaseReadOnly: vi.fn(actual.openDatabaseReadOnly) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const wrapped = {
    ...actual,
    fsyncSync: (fd: number) => {
      fsTrace.calls.push('fsync')
      return actual.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      fsTrace.calls.push('rename')
      if (fsTrace.failRename) throw new Error('simulated crash before the rename')
      if (fsTrace.renameErrors.remaining > 0) {
        fsTrace.renameErrors.remaining--
        throw Object.assign(new Error(`${fsTrace.renameErrors.code}: simulated locked file`), {
          code: fsTrace.renameErrors.code
        })
      }
      return actual.renameSync(from, to)
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsTrace.failRemove) throw new Error('simulated failure removing the temp file')
      return actual.rmSync(...args)
    }
  }
  return { ...wrapped, default: wrapped }
})

const { openDatabaseReadOnly: realOpenReadOnly } = await vi.importActual<
  typeof import('../../src/main/infrastructure/db/connection')
>('../../src/main/infrastructure/db/connection')

const NOW = '2026-10-22T10:00:00.000Z'
const clock = fixedClock(NOW)

const tmpDirs: string[] = []
const openDbs: Database[] = []
function makeSite(): DataPaths {
  const root = mkdtempSync(join(tmpdir(), 'atlas-site-'))
  tmpDirs.push(root)
  return ensureDataLayout(root)
}
const installation = (setupCompletedAt: string | null = NOW): Installation => ({
  installationId: newId(),
  createdAt: NOW,
  setupCompletedAt,
  appVersion: '0.1.0'
})
/** A site whose setup is finished, with a migrated database (connection left open, closed in afterEach). */
function makeInstalledSite(): { paths: DataPaths; db: Database } {
  const paths = makeSite()
  writeInstallation(paths, installation())
  const db = openDatabase(paths.dbFile)
  openDbs.push(db)
  migrate(db)
  db.prepare("INSERT INTO business_days (id, number, opened_at) VALUES ('day-1', 1, ?)").run(NOW)
  return { paths, db }
}
let orderSeq = 0
function insertOrder(
  db: Database,
  o: { status: string; type?: string; tableId?: string; orderNumber?: number; id?: string }
): string {
  const id = o.id ?? newId()
  const opened = new Date(Date.parse(NOW) + orderSeq++ * 1000).toISOString()
  db.prepare(
    `INSERT INTO orders (id, day_id, type, table_id, order_number, status, user_id, opened_at, updated_at)
     VALUES (?, 'day-1', ?, ?, ?, ?, 'u1', ?, ?)`
  ).run(id, o.type ?? 'counter', o.tableId ?? null, o.orderNumber ?? null, o.status, opened, opened)
  return id
}
const closeCleanly = (db: Database): void => {
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const check = (paths: DataPaths, unclean = false, log?: StartupLog) =>
  startupCheck({ paths, clock, unclean, ...(log ? { log } : {}) })

beforeEach(() => {
  fsTrace.calls = []
  fsTrace.failRename = false
  fsTrace.renameErrors = { code: 'EPERM', remaining: 0 }
  fsTrace.failRemove = false
  vi.mocked(openDatabaseReadOnly).mockReset() // back to the real implementation
  orderSeq = 0
})
afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.open) db.close()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolveDataDir', () => {
  const never = (): boolean => false
  const always = (): boolean => true

  it('uses ATLAS_DATA_DIR first, on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(resolveDataDir({ ATLAS_DATA_DIR: '/data/atlas', HOME: '/home/x' }, platform, always)).toBe('/data/atlas')
    }
  })

  it('ignores an empty ATLAS_DATA_DIR', () => {
    expect(resolveDataDir({ ATLAS_DATA_DIR: '  ', HOME: '/home/x' }, 'darwin')).toBe(
      '/home/x/Library/Application Support/AtlasPOS'
    )
  })

  it('Windows: C:\\ProgramData\\AtlasPOS (or the machine ProgramData folder)', () => {
    expect(resolveDataDir({}, 'win32')).toBe('C:\\ProgramData\\AtlasPOS')
    expect(resolveDataDir({ ProgramData: 'D:\\ProgramData' }, 'win32')).toBe('D:\\ProgramData\\AtlasPOS')
  })

  it('macOS: ~/Library/Application Support/AtlasPOS', () => {
    expect(resolveDataDir({ HOME: '/Users/till' }, 'darwin')).toBe('/Users/till/Library/Application Support/AtlasPOS')
  })

  it('Linux: /var/lib/atlas-pos, else ~/.local/share/atlas-pos', () => {
    expect(resolveDataDir({ HOME: '/home/till' }, 'linux', always)).toBe('/var/lib/atlas-pos')
    expect(resolveDataDir({ HOME: '/home/till' }, 'linux', never)).toBe('/home/till/.local/share/atlas-pos')
  })
})

describe('ensureDataLayout', () => {
  it('creates every directory, returns absolute paths, and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-layout-'))
    tmpDirs.push(root)
    const nested = join(root, 'a', 'b')
    const paths = ensureDataLayout(nested)
    expect(paths).toEqual({
      root: nested,
      db: join(nested, 'db'),
      dbFile: join(nested, 'db', 'atlas.db'),
      config: join(nested, 'config'),
      backups: join(nested, 'backups'),
      logs: join(nested, 'logs'),
      prints: join(nested, 'prints'),
      media: join(nested, 'media')
    })
    expect(readdirSync(nested).sort()).toEqual(['backups', 'config', 'db', 'logs', 'media', 'prints'])
    writeFileSync(join(paths.config, 'keep.txt'), 'x')
    expect(ensureDataLayout(nested)).toEqual(paths)
    expect(existsSync(join(paths.config, 'keep.txt'))).toBe(true)
  })
})

/** Runs `fn` with `process.platform` reporting `platform`. */
function asPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('writeFileAtomic', () => {
  const site = (): { dir: string; file: string } => {
    const dir = makeSite().config
    return { dir, file: join(dir, 'data.json') }
  }

  it('writes a new file and replaces an existing one, leaving no temp file', () => {
    const { dir, file } = site()
    writeFileAtomic(file, 'one')
    expect(readFileSync(file, 'utf8')).toBe('one')
    writeFileAtomic(file, new Uint8Array([0x74, 0x77, 0x6f]))
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(readdirSync(dir)).toEqual(['data.json'])
  })

  it('fsyncs the file, renames it, then fsyncs the directory', () => {
    const { file } = site()
    writeFileAtomic(file, 'x')
    expect(fsTrace.calls).toEqual(['fsync', 'rename', 'fsync'])
  })

  it('skips the directory fsync on Windows', () => {
    const { file } = site()
    asPlatform('win32', () => writeFileAtomic(file, 'x'))
    expect(fsTrace.calls).toEqual(['fsync', 'rename'])
  })

  const renameCalls = (): number => fsTrace.calls.filter((c) => c === 'rename').length

  it('on Windows, retries a target that is transiently locked and then succeeds', () => {
    const { dir, file } = site()
    writeFileAtomic(file, 'old')
    fsTrace.calls = []
    fsTrace.renameErrors = { code: 'EBUSY', remaining: 2 }
    asPlatform('win32', () => writeFileAtomic(file, 'new'))
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(renameCalls()).toBe(3)
    expect(readdirSync(dir)).toEqual(['data.json'])
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('on Windows, gives up on %s after 5 tries and keeps the old content', (code) => {
    const { dir, file } = site()
    writeFileAtomic(file, 'old')
    fsTrace.calls = []
    fsTrace.renameErrors = { code, remaining: 99 }
    expect(() => asPlatform('win32', () => writeFileAtomic(file, 'new'))).toThrow(code)
    expect(renameCalls()).toBe(5)
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['data.json'])
  })

  it('does not retry other errors on Windows, nor a locked file on other platforms', () => {
    const { file } = site()
    fsTrace.renameErrors = { code: 'ENOSPC', remaining: 99 }
    expect(() => asPlatform('win32', () => writeFileAtomic(file, 'x'))).toThrow('ENOSPC')
    expect(renameCalls()).toBe(1)

    fsTrace.calls = []
    fsTrace.renameErrors = { code: 'EPERM', remaining: 99 }
    expect(() => asPlatform('linux', () => writeFileAtomic(file, 'x'))).toThrow('EPERM')
    expect(renameCalls()).toBe(1)
  })

  it('a failing cleanup of the temp file never replaces the original error', () => {
    const { dir, file } = site()
    fsTrace.failRename = true
    fsTrace.failRemove = true
    try {
      expect(() => writeFileAtomic(file, 'x')).toThrow('simulated crash before the rename')
    } finally {
      fsTrace.failRemove = false
    }
    expect(readdirSync(dir)).toEqual(['data.json.tmp']) // left behind, replaced by the next write
    fsTrace.failRename = false
    writeFileAtomic(file, 'y')
    expect(readdirSync(dir)).toEqual(['data.json'])
  })

  it('keeps the old content when the process dies before the rename', () => {
    const { dir, file } = site()
    writeFileAtomic(file, 'old content')
    fsTrace.failRename = true
    expect(() => writeFileAtomic(file, 'new content that never lands')).toThrow('simulated crash')
    expect(readFileSync(file, 'utf8')).toBe('old content')
    expect(readdirSync(dir)).toEqual(['data.json'])
  })

  it('leaves no file at all when the very first write dies', () => {
    const { dir, file } = site()
    fsTrace.failRename = true
    expect(() => writeFileAtomic(file, 'x')).toThrow('simulated crash')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('readJsonSafe and the installation file', () => {
  const schema = z.object({ n: z.number() })
  const write = (name: string, content: string): string => {
    const file = join(makeSite().config, name)
    writeFileSync(file, content)
    return file
  }

  it('returns the validated value, or null for anything wrong', () => {
    expect(readJsonSafe(write('ok.json', '{"n":3}'), schema)).toEqual({ n: 3 })
    expect(readJsonSafe(join(makeSite().config, 'missing.json'), schema)).toBeNull()
    expect(readJsonSafe(write('bad.json', '{"n":'), schema)).toBeNull()
    expect(readJsonSafe(write('empty.json', ''), schema)).toBeNull()
    expect(readJsonSafe(write('shape.json', '{"n":"3"}'), schema)).toBeNull()
  })

  it('round-trips config/installation.json', () => {
    const paths = makeSite()
    expect(readInstallation(paths)).toBeNull()
    const value = installation(null)
    writeInstallation(paths, value)
    expect(readInstallation(paths)).toEqual(value)
    expect(JSON.parse(readFileSync(join(paths.config, 'installation.json'), 'utf8'))).toEqual(value)
    writeInstallation(paths, { ...value, setupCompletedAt: NOW })
    expect(readInstallation(paths)?.setupCompletedAt).toBe(NOW)
  })

  it('treats an installation file of the wrong shape as absent', () => {
    const paths = makeSite()
    writeFileSync(join(paths.config, 'installation.json'), '{"installationId":"x"}')
    expect(readInstallation(paths)).toBeNull()
  })
})

describe('openDatabaseReadOnly', () => {
  it('reads, refuses writes, and never creates a missing file', () => {
    const { paths, db } = makeInstalledSite()
    closeCleanly(db)
    const ro = openDatabaseReadOnly(paths.dbFile)
    try {
      expect(ro.prepare('SELECT count(*) AS n FROM business_days').get()).toEqual({ n: 1 })
      expect(() => ro.prepare('DELETE FROM business_days').run()).toThrow(/readonly/i)
    } finally {
      ro.close()
    }
    const missing = join(paths.db, 'nope.db')
    expect(() => openDatabaseReadOnly(missing)).toThrow()
    expect(existsSync(missing)).toBe(false)
  })
})

describe('acquireRunningLock', () => {
  it('a first start is clean, writes the lock, and release removes it', () => {
    const paths = makeSite()
    const lock = acquireRunningLock(paths)
    expect(lock.wasUnclean).toBe(false)
    expect(existsSync(join(paths.config, 'running.lock'))).toBe(true)
    lock.release()
    expect(existsSync(join(paths.config, 'running.lock'))).toBe(false)
    lock.release() // idempotent
  })

  it('a lock left behind means the previous run was unclean', () => {
    const paths = makeSite()
    acquireRunningLock(paths) // never released: a crash or a power cut
    const next = acquireRunningLock(paths)
    expect(next.wasUnclean).toBe(true)
    expect(existsSync(join(paths.config, 'running.lock'))).toBe(true) // this run holds it now
    next.release()
    expect(acquireRunningLock(paths).wasUnclean).toBe(false) // a clean quit clears the history
  })

  it('writes the lock durably (file and directory fsynced)', () => {
    const paths = makeSite()
    fsTrace.calls = []
    acquireRunningLock(paths)
    expect(fsTrace.calls).toEqual(['fsync', 'rename', 'fsync'])
  })
})

// Damage helpers (the database is a real file; the garbage is written into it while it is closed).
const PAGE_FILL = 0xa5
/**
 * A migrated database with enough `event_log` rows to span several pages, closed cleanly. Returns
 * the byte offset where the page in the middle of the table's leaf pages starts.
 */
const siteWithDataPages = (userVersion?: number): { paths: DataPaths; middlePageOffset: number } => {
  const { paths, db } = makeInstalledSite()
  for (let i = 0; i < 300; i++) {
    appendEvent(db, { type: 'x', entity: 'e', entityId: String(i), data: { padding: 'p'.repeat(40) } }, clock)
  }
  if (userVersion !== undefined) db.pragma(`user_version = ${userVersion}`)
  closeCleanly(db)
  const probe = openDatabaseReadOnly(paths.dbFile)
  const leaves = probe
    .prepare("SELECT pageno FROM dbstat WHERE name = 'event_log' AND pagetype = 'leaf' ORDER BY pageno")
    .all() as { pageno: number }[]
  const pageSize = probe.pragma('page_size', { simple: true }) as number
  expect(probe.pragma('quick_check', { simple: true })).toBe('ok') // the damage is what makes it fail
  probe.close()
  expect(leaves.length).toBeGreaterThan(3)
  const middle = leaves[Math.floor(leaves.length / 2)]!.pageno
  return { paths, middlePageOffset: (middle - 1) * pageSize }
}
const overwrite = (file: string, offset: number, length: number): void => {
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, Buffer.alloc(length, PAGE_FILL), 0, length, offset)
  } finally {
    closeSync(fd)
  }
}
/** Garbage over the middle of a data page: quick_check answers with a list of problems. */
const corruptMiddleOfPage = (userVersion?: number): DataPaths => {
  const { paths, middlePageOffset } = siteWithDataPages(userVersion)
  overwrite(paths.dbFile, middlePageOffset + 1500, 256)
  return paths
}
/** Garbage over a page's b-tree header: SQLite refuses to read the file at all (the check throws). */
const corruptBtreeHeader = (userVersion?: number): DataPaths => {
  const { paths, middlePageOffset } = siteWithDataPages(userVersion)
  overwrite(paths.dbFile, middlePageOffset, 64)
  return paths
}
const quickCheckFails = (file: string): boolean => {
  const ro = openDatabaseReadOnly(file)
  try {
    return ro.pragma('quick_check', { simple: true }) !== 'ok'
  } catch {
    return true
  } finally {
    ro.close()
  }
}
const recordLog = (): { events: { event: string; data?: Record<string, unknown> }[]; log: StartupLog } => {
  const events: { event: string; data?: Record<string, unknown> }[] = []
  return { events, log: (event, data) => events.push(data ? { event, data } : { event }) }
}


describe('startupCheck', () => {
  describe('needs-setup', () => {
    it('is reported when there is no installation file, without touching anything', () => {
      const paths = makeSite()
      expect(check(paths)).toEqual<StartupReport>({
        state: 'needs-setup',
        unclean: false,
        integrity: 'ok',
        restoredOrders: [],
        lastBackupAt: null,
        corruptFile: null,
        newerSchema: null
      })
      expect(readdirSync(paths.db)).toEqual([])
    })

    it('is reported while the wizard has not finished, even if a half-built database exists', () => {
      const paths = makeSite()
      writeInstallation(paths, installation(null))
      writeFileSync(paths.dbFile, 'half-built')
      const report = check(paths, true)
      expect(report.state).toBe('needs-setup')
      expect(report.unclean).toBe(true)
      expect(readFileSync(paths.dbFile, 'utf8')).toBe('half-built')
    })
  })

  describe('ok and recovered', () => {
    it('a clean start on a healthy database is ok and lists nothing', () => {
      const { paths, db } = makeInstalledSite()
      insertOrder(db, { status: 'open' })
      closeCleanly(db)
      const report = check(paths)
      expect(report).toMatchObject({ state: 'ok', unclean: false, integrity: 'ok', restoredOrders: [] })
      expect(existsSync(paths.dbFile)).toBe(true)
    })

    it('unclean + 2 open orders is recovered, with those 2 orders', () => {
      const { paths, db } = makeInstalledSite()
      const a = insertOrder(db, { status: 'open', orderNumber: 7 })
      const b = insertOrder(db, { status: 'parked', orderNumber: 8 })
      insertOrder(db, { status: 'closed', orderNumber: 9 })
      insertOrder(db, { status: 'cancelled', orderNumber: 10 })
      closeCleanly(db)
      const report = check(paths, true)
      expect(report.state).toBe('recovered')
      expect(report.unclean).toBe(true)
      expect(report.integrity).toBe('ok')
      expect(report.restoredOrders).toEqual([
        { id: a, type: 'counter', tableLabel: null, orderNumber: 7, idSuffix: a.slice(-6) },
        { id: b, type: 'counter', tableLabel: null, orderNumber: 8, idSuffix: b.slice(-6) }
      ])
    })

    it('unclean with nothing open is still recovered, with an empty list', () => {
      const { paths, db } = makeInstalledSite()
      insertOrder(db, { status: 'closed' })
      closeCleanly(db)
      expect(check(paths, true)).toMatchObject({ state: 'recovered', restoredOrders: [] })
    })

    it('reports table label, order number and the end of the id as separate fields (no composed text)', () => {
      const { paths, db } = makeInstalledSite()
      db.prepare("INSERT INTO rooms (id, name_json) VALUES ('room-1', '{}')").run()
      db.prepare("INSERT INTO tables (id, room_id, label) VALUES ('table-4', 'room-1', 'T4')").run()
      const onTable = insertOrder(db, { status: 'open', type: 'dine_in', tableId: 'table-4', orderNumber: 3 })
      const numbered = insertOrder(db, { status: 'parked', orderNumber: 12 })
      const plain = insertOrder(db, { status: 'open', type: 'takeaway', id: '0198a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' })
      const orphanTable = insertOrder(db, { status: 'open', type: 'delivery', tableId: 'deleted-table', id: 'x-ABCDEF' })
      closeCleanly(db)
      expect(check(paths, true).restoredOrders).toEqual([
        { id: onTable, type: 'dine_in', tableLabel: 'T4', orderNumber: 3, idSuffix: onTable.slice(-6) },
        { id: numbered, type: 'counter', tableLabel: null, orderNumber: 12, idSuffix: numbered.slice(-6) },
        { id: plain, type: 'takeaway', tableLabel: null, orderNumber: null, idSuffix: '3f4a5b' },
        { id: orphanTable, type: 'delivery', tableLabel: null, orderNumber: null, idSuffix: 'ABCDEF' }
      ])
    })

    it('recovers what a power cut left in the -wal file (committed, never checkpointed)', () => {
      // Copy the files while the writer is still connected and has not checkpointed: exactly what
      // is on disk after a power cut. The -shm index is never part of it.
      const live = makeInstalledSite()
      const open1 = insertOrder(live.db, { status: 'open', orderNumber: 1 })
      const open2 = insertOrder(live.db, { status: 'parked', orderNumber: 2 })
      expect(existsSync(`${live.paths.dbFile}-wal`)).toBe(true)
      const cut = makeSite()
      writeInstallation(cut, installation())
      copyFileSync(live.paths.dbFile, cut.dbFile)
      copyFileSync(`${live.paths.dbFile}-wal`, `${cut.dbFile}-wal`)
      const report = check(cut, true)
      expect(report.state).toBe('recovered')
      expect(report.restoredOrders.map((o) => o.id)).toEqual([open1, open2])
    })

    it('lastBackupAt is the latest backup that succeeded on at least one destination', () => {
      const { paths, db } = makeInstalledSite()
      const run = (at: string, results: string): void => {
        db.prepare(
          `INSERT INTO backup_runs (id, at, kind, file_name, sha256, bytes, results_json)
           VALUES (?, ?, 'live', 'f.atlasbak', 'abc', 1, ?)`
        ).run(newId(), at, results)
      }
      const result = (targetId: string, role: string, ok: boolean) => ({ targetId, role, ok })
      run('2026-10-20T08:00:00.000Z', JSON.stringify([result('t1', 'disk', true)]))
      run('2026-10-21T20:00:00.000Z', JSON.stringify([result('t2', 'usb', false), result('t1', 'disk', true)]))
      run('2026-10-21T23:00:00.000Z', JSON.stringify([result('t2', 'usb', false)]))
      run('2026-10-22T08:00:00.000Z', 'not json at all')
      run('2026-10-22T09:00:00.000Z', '[]')
      closeCleanly(db)
      expect(check(paths).lastBackupAt).toBe('2026-10-21T20:00:00.000Z')
    })

    it('lastBackupAt is null when there is no successful backup', () => {
      const { paths, db } = makeInstalledSite()
      closeCleanly(db)
      expect(check(paths).lastBackupAt).toBeNull()
    })
  })

  describe('corrupt', () => {
    it('overwritten bytes in the middle of a page: corrupt, and the file is moved to db/corrupt-<ts>.db', () => {
      const paths = corruptMiddleOfPage()
      expect(quickCheckFails(paths.dbFile)).toBe(true)
      const damagedHash = sha256(paths.dbFile)
      const { events, log } = recordLog()

      const report = check(paths, false, log)

      const moved = join(paths.db, 'corrupt-20261022T100000000Z.db')
      expect(report).toMatchObject({
        state: 'corrupt',
        unclean: false,
        integrity: 'failed',
        restoredOrders: [],
        lastBackupAt: null,
        corruptFile: moved
      })
      expect(existsSync(paths.dbFile)).toBe(false)
      expect(sha256(moved)).toBe(damagedHash)
      // Nothing named atlas.db* is left behind (the probe connections above created -wal/-shm files, which move too).
      expect(readdirSync(paths.db).filter((f) => !f.startsWith('corrupt-20261022T100000000Z.db'))).toEqual([])
      // quick_check fails, so the full integrity_check runs and confirms it.
      expect(events.map((e) => [e.event, e.data?.['check']])).toEqual([
        ['startup.integrity_failed', 'quick_check'],
        ['startup.integrity_failed', 'integrity_check'],
        ['startup.db_quarantined', undefined]
      ])
    })

    it('a damaged b-tree header, which SQLite refuses to read, is corrupt too', () => {
      const paths = corruptBtreeHeader()
      expect(quickCheckFails(paths.dbFile)).toBe(true)
      const { events, log } = recordLog()
      const report = check(paths, false, log)
      expect(report).toMatchObject({ state: 'corrupt', integrity: 'failed' })
      expect(report.corruptFile && existsSync(report.corruptFile)).toBe(true)
      expect(existsSync(paths.dbFile)).toBe(false)
      expect(events.map((e) => e.event)).toEqual(['startup.integrity_failed', 'startup.db_quarantined'])
    })

    it('unclean + corrupt is corrupt (never recovered)', () => {
      expect(check(corruptMiddleOfPage(), true)).toMatchObject({ state: 'corrupt', unclean: true, integrity: 'failed' })
    })

    it('a file that is not a database at all is corrupt', () => {
      const paths = makeSite()
      writeInstallation(paths, installation())
      writeFileSync(paths.dbFile, 'this is not a sqlite database, '.repeat(300))
      const report = check(paths)
      expect(report.state).toBe('corrupt')
      expect(report.integrity).toBe('failed')
      expect(existsSync(paths.dbFile)).toBe(false)
      expect(report.corruptFile && existsSync(report.corruptFile)).toBe(true)
    })

    it('an empty database file, after a finished setup, is corrupt: it must not be silently recreated', () => {
      const paths = makeSite()
      writeInstallation(paths, installation())
      writeFileSync(paths.dbFile, '')
      expect(check(paths)).toMatchObject({ state: 'corrupt', integrity: 'failed' })
      expect(existsSync(paths.dbFile)).toBe(false)
    })

    it('a missing database after a finished setup is corrupt (restore is offered); stray -wal/-shm files are moved aside', () => {
      const paths = makeSite()
      writeInstallation(paths, installation())
      writeFileSync(`${paths.dbFile}-wal`, 'orphan wal')
      writeFileSync(`${paths.dbFile}-shm`, 'orphan shm')
      const report = check(paths, true)
      expect(report).toMatchObject({ state: 'corrupt', unclean: true, integrity: 'failed', corruptFile: null })
      expect(readdirSync(paths.db).sort()).toEqual([
        'corrupt-20261022T100000000Z.db-shm',
        'corrupt-20261022T100000000Z.db-wal'
      ])
    })

    it('moves the -wal and -shm files together with the database', () => {
      const paths = makeSite()
      writeInstallation(paths, installation())
      writeFileSync(paths.dbFile, 'garbage'.repeat(1000))
      writeFileSync(`${paths.dbFile}-wal`, 'w')
      writeFileSync(`${paths.dbFile}-shm`, 's')
      check(paths)
      expect(readdirSync(paths.db).sort()).toEqual([
        'corrupt-20261022T100000000Z.db',
        'corrupt-20261022T100000000Z.db-shm',
        'corrupt-20261022T100000000Z.db-wal'
      ])
    })
  })

  describe('newer-schema', () => {
    it('refuses a database newer than the app and never writes to it', () => {
      const { paths, db } = makeInstalledSite()
      const newer = migrations.length + 1
      insertOrder(db, { status: 'open' })
      db.pragma(`user_version = ${newer}`)
      closeCleanly(db)
      const before = sha256(paths.dbFile)

      const report = check(paths, true)

      expect(report).toEqual<StartupReport>({
        state: 'newer-schema',
        unclean: true,
        integrity: 'ok',
        restoredOrders: [],
        lastBackupAt: null,
        corruptFile: null,
        newerSchema: { found: newer, supported: migrations.length }
      })
      expect(sha256(paths.dbFile)).toBe(before)
      expect(readdirSync(paths.db).filter((f) => f.startsWith('corrupt-'))).toEqual([])
      const ro = openDatabaseReadOnly(paths.dbFile)
      expect(ro.pragma('user_version', { simple: true })).toBe(newer)
      ro.close()
    })

    it.each([
      ['garbage in the middle of a page (the check reports problems)', corruptMiddleOfPage],
      ['a damaged b-tree header (the check throws)', corruptBtreeHeader]
    ])('stays newer-schema when the integrity check also fails, reports it, never moves the file: %s', (_name, damage) => {
      const newer = migrations.length + 1
      const paths = damage(newer)
      expect(quickCheckFails(paths.dbFile)).toBe(true)
      const before = sha256(paths.dbFile)

      const report = check(paths, true)

      expect(report).toMatchObject({
        state: 'newer-schema',
        integrity: 'failed',
        restoredOrders: [],
        corruptFile: null,
        newerSchema: { found: newer, supported: migrations.length }
      })
      expect(existsSync(paths.dbFile)).toBe(true)
      expect(sha256(paths.dbFile)).toBe(before)
      expect(readdirSync(paths.db).filter((f) => f.startsWith('corrupt-'))).toEqual([])
    })
  })

  describe('an error that does not prove corruption is thrown, and the database is left alone', () => {
    const sqliteError = (code: string, message: string): Error => Object.assign(new Error(message), { code })

    const expectUntouched = (paths: DataPaths, before: string): void => {
      expect(existsSync(paths.dbFile)).toBe(true)
      expect(sha256(paths.dbFile)).toBe(before)
      expect(readdirSync(paths.db).filter((f) => f.startsWith('corrupt-'))).toEqual([])
    }
    const healthySite = (): { paths: DataPaths; before: string } => {
      const { paths, db } = makeInstalledSite()
      insertOrder(db, { status: 'open' })
      closeCleanly(db)
      return { paths, before: sha256(paths.dbFile) }
    }

    it.each([
      ['SQLITE_BUSY', 'database is locked'],
      ['SQLITE_CANTOPEN', 'unable to open database file'],
      ['SQLITE_IOERR', 'disk I/O error']
    ])('%s while opening', (code, message) => {
      const { paths, before } = healthySite()
      vi.mocked(openDatabaseReadOnly).mockImplementationOnce(() => {
        throw sqliteError(code, message)
      })
      expect(() => check(paths, true)).toThrow(message)
      expectUntouched(paths, before)
    })

    it.each([
      ['SQLITE_BUSY', 'database is locked'],
      ['SQLITE_IOERR_READ', 'disk I/O error']
    ])('%s during the integrity check (and the handle is still closed)', (code, message) => {
      const { paths, before } = healthySite()
      let real: Database | undefined
      vi.mocked(openDatabaseReadOnly).mockImplementationOnce((file) => {
        real = realOpenReadOnly(file)
        const target = real
        return new Proxy(target, {
          get(t, prop) {
            if (prop === 'pragma') {
              return (source: string, options?: { simple?: boolean }) => {
                if (source.startsWith('quick_check')) throw sqliteError(code, message)
                return t.pragma(source, options)
              }
            }
            const value: unknown = Reflect.get(t, prop)
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
          }
        })
      })
      expect(() => check(paths, true)).toThrow(message)
      expect(real?.open).toBe(false)
      expectUntouched(paths, before)
    })
  })

  describe('a schema that a later migration changed', () => {
    it('a removed backup_runs table gives lastBackupAt null instead of failing the start', () => {
      const { paths, db } = makeInstalledSite()
      db.exec('DROP TABLE backup_runs')
      closeCleanly(db)
      const { events, log } = recordLog()
      expect(check(paths, false, log)).toMatchObject({ state: 'ok', integrity: 'ok', lastBackupAt: null })
      expect(events).toEqual([{ event: 'startup.read_degraded', data: expect.objectContaining({ what: 'backup_runs' }) }])
    })

    it('a renamed orders column gives no restored orders instead of failing an unclean start', () => {
      const { paths, db } = makeInstalledSite()
      insertOrder(db, { status: 'open' })
      db.exec('ALTER TABLE orders RENAME COLUMN order_number TO number')
      closeCleanly(db)
      const { events, log } = recordLog()
      expect(check(paths, true, log)).toMatchObject({ state: 'recovered', integrity: 'ok', restoredOrders: [] })
      expect(events).toEqual([{ event: 'startup.read_degraded', data: expect.objectContaining({ what: 'orders' }) }])
    })

    it('a removed tables table is handled the same way', () => {
      const { paths, db } = makeInstalledSite()
      insertOrder(db, { status: 'open' })
      db.exec('DROP TABLE tables')
      closeCleanly(db)
      expect(check(paths, true)).toMatchObject({ state: 'recovered', restoredOrders: [] })
    })
  })
})
