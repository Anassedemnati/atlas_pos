import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from '@shared/ids'
import type { BackupDraft } from '@shared/setup/draft'
import type { Result } from '@shared/result'
import { folderTarget, testTarget, usbTarget, type BackupTarget } from '../../../infrastructure/backup/targets'
import { BACKUP_DIR, TARGET_MARKER } from '../../../infrastructure/backup/usb-scan'
import { AppErrorException } from '../../errors'
import { refuse } from '../users/outcome'

export interface TargetTestInput {
  role: BackupDraft['role']
  path: string
  label?: string | undefined
  targetKey?: string | undefined
  overwrite?: boolean | undefined
}

/** The marker's content (a target key), or null when the folder has no marker. */
async function markerOf(path: string): Promise<string | null> {
  try {
    return (await readFile(join(path, BACKUP_DIR, TARGET_MARKER), 'utf8')).trim() || null
  } catch {
    return null
  }
}

const targetFor = (input: TargetTestInput, key: string): BackupTarget =>
  input.role === 'usb'
    ? usbTarget({ id: 'setup', targetKey: key, path: input.path, ...(input.label ? { label: input.label } : {}) })
    : folderTarget({ id: 'setup', role: input.role, path: input.path, targetKey: key, ...(input.label ? { label: input.label } : {}) })

/**
 * The wizard's "Tester" button: writes, reads back and verifies a probe, and marks the destination with
 * `AtlasBackup/.atlas-target` (content = its key, new unless `targetKey` is given). A marker that holds a
 * different key belongs to another installation (or an earlier setup): `marker_conflict`, unless `overwrite`.
 * `testTarget` itself overwrites a different marker without asking, hence the check first.
 */
export async function testBackupTarget(input: TargetTestInput): Promise<Result<{ targetKey: string; writableBytes: number }>> {
  const key = input.targetKey?.trim() || newId()
  const existing = await markerOf(input.path)
  if (existing !== null && existing !== key && input.overwrite !== true) return refuse('marker_conflict', { existingKey: existing })
  const tested = await testTarget(targetFor(input, key))
  return tested.ok ? { ok: true, value: { targetKey: key, writableBytes: tested.value.writableBytes } } : tested
}

/**
 * Before the database exists: every destination of the draft must carry a key (`backups[n].targetKey`) and
 * pass its test, which also writes its marker, so the first backup finds it. Throws with `params.field`.
 */
export async function ensureTargets(backups: BackupDraft[]): Promise<void> {
  for (const [i, backup] of backups.entries()) {
    const tested = await testBackupTarget(backup)
    if (!tested.ok) throw new AppErrorException(tested.error.code, { ...tested.error.params, field: `backups.${i}.path` })
  }
}
