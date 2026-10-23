import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fullBackupName,
  parseBackupStamp,
  rotateDir,
  selectForDeletion
} from '../../../src/main/infrastructure/backup/rotation'

const DAY = 24 * 60 * 60 * 1000

/** One `full` backup a day at 08:00 local time, `days` days back from `newest` (newest first). */
function dailies(newest: Date, days: number): { name: string; at: Date }[] {
  return Array.from({ length: days }, (_, i) => {
    const at = new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() - i, 8, 0)
    return { name: fullBackupName(at, 'full'), at }
  })
}

describe('backup file names', () => {
  it('formats atlas-YYYYMMDD-HHmm-<kind>[-<label>] in local time and parses it back', () => {
    const at = new Date(2026, 9, 22, 7, 5)
    expect(fullBackupName(at, 'full', 'Z12')).toBe('atlas-20261022-0705-full-Z12.atlasbak')
    expect(fullBackupName(at, 'pre-change')).toBe('atlas-20261022-0705-pre-change.atlasbak')
    expect(fullBackupName(at, 'manual', 'avant / réglage')).toBe('atlas-20261022-0705-manual-avant-r-glage.atlasbak')
    expect(parseBackupStamp('atlas-20261022-0705-full-Z12.atlasbak')?.getTime()).toBe(at.getTime())
    expect(parseBackupStamp('atlas-live.atlasbak')).toBeNull()
    expect(parseBackupStamp('notes.txt')).toBeNull()
  })
})

describe('selectForDeletion', () => {
  const now = new Date(2026, 9, 22, 10, 0) // 22 Oct 2026, 10:00 local

  it('with 60 daily fulls keeps the last 30 days plus the newest of each month', () => {
    const files = dailies(now, 60) // 22 Oct back to 24 Aug
    const deleted = new Set(selectForDeletion(files.map((f) => f.name), now, 30))
    const kept = files.filter((f) => !deleted.has(f.name))

    // Days 0..29 are within 30 days (day 30, at 08:00, is 30 days and 2 hours old: a DST change in between cannot bring it inside).
    const last30 = files.slice(0, 30)
    for (const f of last30) expect(deleted.has(f.name)).toBe(false)
    // Older than that, only the newest of a month survives: 31 Aug (Sep's newest, 30 Sep, is already kept).
    expect(kept.map((f) => f.name)).toEqual([...last30.map((f) => f.name), fullBackupName(new Date(2026, 7, 31, 8, 0), 'full')])
    expect(deleted.size).toBe(29)
  })

  it('never deletes the newest 3, even when every full is past retention', () => {
    const newest = new Date(2026, 6, 10, 8, 0) // 10 Jul
    const files = dailies(newest, 20) // 10 Jul back to 21 Jun
    const deleted = new Set(selectForDeletion(files.map((f) => f.name), now, 30))
    const kept = files.filter((f) => !deleted.has(f.name)).map((f) => f.name)

    expect(kept).toEqual([
      fullBackupName(new Date(2026, 6, 10, 8, 0), 'full'), // newest + newest of July
      fullBackupName(new Date(2026, 6, 9, 8, 0), 'full'),
      fullBackupName(new Date(2026, 6, 8, 8, 0), 'full'),
      fullBackupName(new Date(2026, 5, 30, 8, 0), 'full') // newest of June
    ])
  })

  it('drops monthly copies older than 12 months', () => {
    const old = [new Date(2025, 8, 30, 8, 0), new Date(2025, 9, 30, 8, 0), new Date(2025, 10, 30, 8, 0)]
    const recent = dailies(now, 3)
    const names = [...recent, ...old.map((at) => ({ name: fullBackupName(at, 'full'), at }))].map((f) => f.name)
    const deleted = selectForDeletion(names, now, 30)
    // 30 Sep 2025 and 30 Oct 2025 are more than 12 months before 22 Oct 2026; 30 Nov 2025 is not.
    expect(deleted.sort()).toEqual([fullBackupName(old[0]!, 'full'), fullBackupName(old[1]!, 'full')].sort())
  })

  it('ignores names that are not dated backups', () => {
    expect(selectForDeletion(['atlas-live.atlasbak', 'readme.txt'], now, 30)).toEqual([])
  })
})

describe('rotateDir', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('deletes the selected backups together with their manifests and leaves other files alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-rot-'))
    const now = new Date(2026, 9, 22, 10, 0)
    const files = dailies(new Date(now.getTime() - 100 * DAY), 5)
    for (const f of files) {
      writeFileSync(join(dir, f.name), 'x')
      writeFileSync(join(dir, `${f.name}.json`), '{}')
    }
    writeFileSync(join(dir, 'other.txt'), 'keep')

    const deleted = await rotateDir(dir, now, 30)

    expect(deleted.sort()).toEqual([files[3]!.name, files[4]!.name].sort())
    expect(existsSync(join(dir, files[4]!.name))).toBe(false)
    expect(existsSync(join(dir, `${files[4]!.name}.json`))).toBe(false)
    expect(readdirSync(dir).length).toBe(3 * 2 + 1)
  })

  it('treats a missing directory as nothing to rotate', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-rot-'))
    expect(await rotateDir(join(dir, 'absent'), new Date(), 30)).toEqual([])
  })
})
