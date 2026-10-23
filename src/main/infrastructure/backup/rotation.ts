import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupKind } from './snapshot'

const DAY_MS = 24 * 60 * 60 * 1000
/** Never deleted, whatever their age. */
const KEEP_NEWEST = 3
/** Monthly copies are kept for the current month and the 11 before it. */
const MONTHS_KEPT = 12

const NAME = /^atlas-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-.+\.atlasbak$/

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Keeps a label to `[A-Za-z0-9_]` runs joined by `-`, so it is safe in a file name on every OS. */
const sanitizeLabel = (label: string): string =>
  label
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/**
 * `atlas-YYYYMMDD-HHmm-<kind>[-<label>].atlasbak`, in the till's local time (the shopkeeper reads
 * these names), e.g. `atlas-20261022-2315-full-Z12.atlasbak`.
 */
export function fullBackupName(at: Date, kind: Exclude<BackupKind, 'live'>, label?: string): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  const suffix = label ? sanitizeLabel(label) : ''
  return `atlas-${stamp}-${kind}${suffix ? `-${suffix}` : ''}.atlasbak`
}

/** The local time a dated backup name carries, or null for any other name. */
export function parseBackupStamp(name: string): Date | null {
  const m = NAME.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  const at = new Date(y, mo - 1, d, h, mi)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * Which dated backups to delete. Kept:
 * - every backup from the last `retentionDays` days (`now - retentionDays × 24 h` inclusive);
 * - the newest backup of each calendar month, for the current month and the 11 before it;
 * - the newest 3, always.
 * Names that are not dated backups are never selected.
 */
export function selectForDeletion(names: readonly string[], now: Date, retentionDays: number): string[] {
  const dated = names
    .map((name) => ({ name, at: parseBackupStamp(name) }))
    .filter((e): e is { name: string; at: Date } => e.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name))

  const keep = new Set(dated.slice(0, KEEP_NEWEST).map((e) => e.name))
  const cutoff = now.getTime() - retentionDays * DAY_MS
  const monthIndex = (d: Date): number => d.getFullYear() * 12 + d.getMonth()
  const currentMonth = monthIndex(now)
  const monthsSeen = new Set<number>()
  for (const e of dated) {
    if (e.at.getTime() >= cutoff) keep.add(e.name)
    const month = monthIndex(e.at)
    if (!monthsSeen.has(month)) {
      monthsSeen.add(month) // `dated` is newest first: this is the month's newest
      if (currentMonth - month < MONTHS_KEPT) keep.add(e.name)
    }
  }
  return dated.filter((e) => !keep.has(e.name)).map((e) => e.name)
}

/**
 * Applies `selectForDeletion` to the `.atlasbak` files of `dir`, deleting each selected file and
 * its `.json` manifest. Returns the deleted backup names; a missing directory has nothing to rotate.
 */
export async function rotateDir(dir: string, now: Date, retentionDays: number): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const doomed = selectForDeletion(names, now, retentionDays)
  for (const name of doomed) {
    await rm(join(dir, name), { force: true })
    await rm(join(dir, `${name}.json`), { force: true })
  }
  return doomed
}
