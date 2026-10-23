import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The folder every target holds, and the marker file that names a USB target. */
export const BACKUP_DIR = 'AtlasBackup'
/**
 * `<mount>/AtlasBackup/.atlas-target`: a text file whose content (trimmed) is the target's
 * `target_key`. The setup wizard writes it when a USB target is tested.
 */
export const TARGET_MARKER = '.atlas-target'

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
  const key = targetKey.trim()
  if (!key) return null
  const list = options.listCandidateRoots ?? listCandidateRoots
  for (const root of await list(options.platform ?? process.platform)) {
    try {
      const marker = await readFile(join(root, BACKUP_DIR, TARGET_MARKER), 'utf8')
      if (marker.trim() === key) return root
    } catch {
      // No marker, or the drive is not readable: not this one.
    }
  }
  return null
}
