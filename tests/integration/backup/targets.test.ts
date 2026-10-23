import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  copyFileAtomic,
  folderTarget,
  targetsFromDestinations,
  testTarget,
  usbTarget
} from '../../../src/main/infrastructure/backup/targets'
import { listCandidateRoots, usbScan } from '../../../src/main/infrastructure/backup/usb-scan'
import { backupFixture, type BackupFixture } from '../../helpers/backup'

const writeMarker = (root: string, key: string): void => {
  mkdirSync(join(root, 'AtlasBackup'), { recursive: true })
  writeFileSync(join(root, 'AtlasBackup', '.atlas-target'), `${key}\n`)
}

describe('backup targets', () => {
  let fx: BackupFixture
  beforeEach(() => {
    fx = backupFixture(0)
  })
  afterEach(() => fx.cleanup())

  it('a folder target resolves to its path when writable, and never creates a missing one', async () => {
    const disk = fx.newDir('disk')
    expect(await folderTarget({ id: 'd', role: 'disk', path: disk }).resolveRoot()).toBe(disk)

    const absent = join(fx.dir, 'nas-not-mounted')
    expect(await folderTarget({ id: 'n', role: 'nas', path: absent }).resolveRoot()).toBeNull()
    expect(existsSync(absent)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only folder is not available', async () => {
    const ro = fx.newDir('ro')
    chmodSync(ro, 0o555)
    try {
      expect(await folderTarget({ id: 'd', role: 'disk', path: ro }).resolveRoot()).toBeNull()
    } finally {
      chmodSync(ro, 0o755)
    }
  })

  it('usbScan finds the mount whose AtlasBackup/.atlas-target holds the key', async () => {
    const a = fx.newDir('usb-a')
    const b = fx.newDir('usb-b')
    const c = fx.newDir('usb-c')
    writeMarker(a, 'other-key')
    writeMarker(b, 'key-123')
    const roots = async () => [c, a, b]

    expect(await usbScan('key-123', { platform: 'linux', listCandidateRoots: roots })).toBe(b)
    expect(await usbScan('key-999', { platform: 'linux', listCandidateRoots: roots })).toBeNull()
    expect(await usbScan('', { platform: 'linux', listCandidateRoots: roots })).toBeNull()
  })

  it('a USB target resolves through its scan', async () => {
    const mount = fx.newDir('usb')
    const target = usbTarget({ id: 'u', targetKey: 'k1', label: 'Clé USB' }, (key) =>
      usbScan(key, { platform: 'linux', listCandidateRoots: async () => [mount] })
    )
    expect(target.role).toBe('usb')
    expect(target.describe()).toBe('Clé USB')
    expect(await target.resolveRoot()).toBeNull()
    writeMarker(mount, 'k1')
    expect(await target.resolveRoot()).toBe(mount)
  })

  it.runIf(process.platform === 'darwin')('the macOS scanner lists /Volumes/*', async () => {
    const roots = await listCandidateRoots('darwin')
    expect(roots.length).toBeGreaterThan(0)
    for (const r of roots) expect(r.startsWith('/Volumes/')).toBe(true)
  })

  it('testTarget writes, reads back and deletes a 1 MB probe, and reports free space', async () => {
    const disk = fx.newDir('disk')
    const result = await testTarget(folderTarget({ id: 'd', role: 'disk', path: disk }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.writableBytes).toBeGreaterThan(1024 * 1024)
    expect(readdirSync(join(disk, 'AtlasBackup'))).toEqual([])

    const missing = await testTarget(folderTarget({ id: 'n', role: 'nas', path: join(fx.dir, 'nope') }))
    expect(missing).toEqual({
      ok: false,
      error: { code: 'backup_target_unavailable', messageKey: 'errors.backup_target_unavailable', params: { targetId: 'n' } }
    })
  })

  it('copyFileAtomic replaces the destination and leaves no temp file', async () => {
    const disk = fx.newDir('disk')
    const src = join(fx.dir, 'src.bin')
    writeFileSync(src, 'new content')
    const dest = join(disk, 'out.bin')
    writeFileSync(dest, 'old')
    await copyFileAtomic(src, dest)
    expect(readFileSync(dest, 'utf8')).toBe('new content')
    expect(readdirSync(disk)).toEqual(['out.bin'])
  })

  it('targetsFromDestinations builds one target per enabled backup_destinations row', async () => {
    const disk = fx.newDir('disk')
    const insert = fx.db.prepare(
      'INSERT INTO backup_destinations (id, role, path, label, target_key, enabled) VALUES (?, ?, ?, ?, ?, ?)'
    )
    insert.run('t1', 'disk', disk, 'Disque 2', '', 1)
    insert.run('t2', 'usb', '', 'Clé', 'k-usb', 1)
    insert.run('t3', 'nas', '/nowhere', 'NAS', '', 0)

    const targets = targetsFromDestinations(fx.db, async () => null)
    expect(targets.map((t) => [t.id, t.role, t.describe()])).toEqual([
      ['t1', 'disk', 'Disque 2'],
      ['t2', 'usb', 'Clé']
    ])
    expect(await targets[0]!.resolveRoot()).toBe(disk)
    expect(await targets[1]!.resolveRoot()).toBeNull()
  })
})
