import { basename, dirname } from 'node:path'
import type { BackupEntryDto } from '@shared/dto'
import type { BackupEntry } from './restore'
import type { BackupTarget } from './targets'
import { BACKUP_DIR } from './usb-scan'

/**
 * A folder chosen by hand, read like a destination's root (`AtlasBackup/full`, `AtlasBackup/live`). The
 * `AtlasBackup` folder itself is accepted too (its parent is the root).
 */
export function pickedFolderTarget(folder: string): BackupTarget {
  const root = basename(folder) === BACKUP_DIR ? dirname(folder) : folder
  return {
    id: 'picked',
    role: 'disk',
    targetKey: '',
    describe: () => root,
    resolveRoot: async () => root,
    setupRoot: async () => root
  }
}

export const toBackupEntryDto = (entry: BackupEntry, picked: boolean): BackupEntryDto => ({
  source: picked ? 'picked' : entry.source,
  role: entry.role,
  file: entry.file,
  fileName: entry.fileName,
  createdAt: entry.manifest.createdAt,
  kind: entry.manifest.kind,
  schemaVersion: entry.manifest.schemaVersion,
  appVersion: entry.manifest.appVersion
})
