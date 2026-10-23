import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The folder every target holds, and the marker file that names it. */
export const BACKUP_DIR = 'AtlasBackup'
/**
 * `<root>/AtlasBackup/.atlas-target`: a text file whose content (trimmed) is the target's
 * `target_key`, for every role (disk, NAS, USB). `testTarget` (the setup "Tester" button) writes
 * it. A root without the right marker is not the destination: an unmounted NAS mount point is an
 * empty local folder, and a backup must never land there.
 */
export const TARGET_MARKER = '.atlas-target'

/** True when `<root>/AtlasBackup/.atlas-target` holds `targetKey` (a blank key never matches). Never throws. */
export async function hasTargetMarker(root: string, targetKey: string): Promise<boolean> {
  const key = targetKey.trim()
  if (!key) return false
  try {
    return (await readFile(join(root, BACKUP_DIR, TARGET_MARKER), 'utf8')).trim() === key
  } catch {
    return false
  }
}

/** The sub-directories of `parent` (absolute), or none when it cannot be read. */
async function subdirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(parent, e.name))
  } catch {
    return []
  }
}

/**
 * Where removable drives are mounted, by platform:
 * - Windows: the drive letters `D:\` to `Z:\` that exist;
 * - Linux: `/media/<user>/<label>` and `/run/media/<user>/<label>`;
 * - macOS: `/Volumes/<label>`.
 */
export async function listCandidateRoots(platform: NodeJS.Platform): Promise<string[]> {
  switch (platform) {
    case 'win32': {
      const roots: string[] = []
      for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
        const root = `${String.fromCharCode(c)}:\\`
        if (existsSync(root)) roots.push(root)
      }
      return roots
    }
    case 'darwin':
      return subdirs('/Volumes')
    default: {
      const users = [...(await subdirs('/media')), ...(await subdirs('/run/media'))]
      return (await Promise.all(users.map(subdirs))).flat()
    }
  }
}

export interface UsbScanOptions {
  platform?: NodeJS.Platform
  listCandidateRoots?: (platform: NodeJS.Platform) => Promise<string[]>
}

/** The mount root whose `AtlasBackup/.atlas-target` holds `targetKey`, or null when none is plugged in. */
export async function usbScan(targetKey: string, options: UsbScanOptions = {}): Promise<string | null> {
  if (!targetKey.trim()) return null
  const list = options.listCandidateRoots ?? listCandidateRoots
  for (const root of await list(options.platform ?? process.platform)) {
    if (await hasTargetMarker(root, targetKey)) return root
  }
  return null
}
