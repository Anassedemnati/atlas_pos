import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { backupFixture, writeMarker, type BackupFixture } from '../../helpers/backup'


describe('backup targets', () => {
  let fx: BackupFixture
  beforeEach(() => {
    fx = backupFixture(0)
  })
  afterEach(() => fx.cleanup())

  it('a folder target resolves to its path only when writable and marked with its key, and never creates a missing one', async () => {
    const disk = fx.newDir('disk')
    const target = folderTarget({ id: 'd', role: 'disk', path: disk, targetKey: 'k-disk' })
    expect(await target.resolveRoot()).toBeNull() // not marked yet
    expect(await target.setupRoot()).toBe(disk)
    writeMarker(disk, 'k-other')
    expect(await target.resolveRoot()).toBeNull() // someone else's marker
    writeMarker(disk, 'k-disk')
    expect(await target.resolveRoot()).toBe(disk)
    expect(await folderTarget({ id: 'd', role: 'disk', path: disk, targetKey: '' }).resolveRoot()).toBeNull()

    const absent = join(fx.dir, 'nas-not-mounted')
    const nas = folderTarget({ id: 'n', role: 'nas', path: absent, targetKey: 'k-nas' })
    expect(await nas.resolveRoot()).toBeNull()
    expect(await nas.setupRoot()).toBeNull()
    expect(existsSync(absent)).toBe(false)
  })

  it('an unmounted NAS mount point (an empty local folder) is not available', async () => {
    const mountPoint = fx.newDir('mnt-nas')
    expect(await folderTarget({ id: 'n', role: 'nas', path: mountPoint, targetKey: 'k-nas' }).resolveRoot()).toBeNull()
    expect(readdirSync(mountPoint)).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only folder is not available', async () => {
    const ro = fx.newDir('ro')
    try {
      writeMarker(ro, 'k')
      chmodSync(ro, 0o555)
      expect(await folderTarget({ id: 'd', role: 'disk', path: ro, targetKey: 'k' }).resolveRoot()).toBeNull()
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

  it('testTarget marks the folder, writes, reads back and deletes a 1 MB probe, and reports free space', async () => {
    const disk = fx.newDir('disk')
    const target = folderTarget({ id: 'd', role: 'disk', path: disk, targetKey: 'k-disk' })
    const result = await testTarget(target)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.writableBytes).toBeGreaterThan(1024 * 1024)
    expect(readdirSync(join(disk, 'AtlasBackup'))).toEqual(['.atlas-target'])
    expect(readFileSync(join(disk, 'AtlasBackup', '.atlas-target'), 'utf8').trim()).toBe('k-disk')
    expect(await target.resolveRoot()).toBe(disk)

    // A USB is marked at the path it was mounted at when configured, then found by its marker.
    const mount = fx.newDir('usb')
    const usb = usbTarget({ id: 'u', targetKey: 'k-usb', path: mount }, (key) =>
      usbScan(key, { platform: 'linux', listCandidateRoots: async () => [mount] })
    )
    expect((await testTarget(usb)).ok).toBe(true)
    expect(await usb.resolveRoot()).toBe(mount)

    const missing = await testTarget(folderTarget({ id: 'n', role: 'nas', path: join(fx.dir, 'nope'), targetKey: 'k' }))
    expect(missing).toEqual({
      ok: false,
      error: { code: 'backup_target_unavailable', messageKey: 'errors.backup_target_unavailable', params: { targetId: 'n' } }
    })
  })

  it('testTarget never rejects, even when resolving the target throws', async () => {
    const broken = {
      id: 'x',
      role: 'nas' as const,
      targetKey: 'k',
      describe: () => 'x',
      resolveRoot: async () => {
        throw new Error('EIO')
      },
      setupRoot: async () => null
    }
    const result = await testTarget(broken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('backup_probe_failed')
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
    insert.run('t1', 'disk', disk, 'Disque 2', 'k-disk', 1)
    writeMarker(disk, 'k-disk')
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
