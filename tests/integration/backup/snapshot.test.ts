import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../../../src/main/infrastructure/db/migrate'
import { createSnapshot, verifySnapshot } from '../../../src/main/infrastructure/backup/snapshot'
import { backupFixture, type BackupFixture } from '../../helpers/backup'

const meta = {
  kind: 'manual' as const,
  appVersion: '0.1.0',
  installationId: 'inst-test',
  createdAt: new Date('2026-10-22T10:00:00.000Z')
}

describe('createSnapshot / verifySnapshot', () => {
  let fx: BackupFixture
  let tmp: string
  beforeEach(() => {
    fx = backupFixture(7)
    tmp = join(fx.paths.backups, 'tmp')
  })
  afterEach(() => fx.cleanup())

  it('writes a gzipped .atlasbak and its manifest, and the snapshot verifies', async () => {
    const snap = await createSnapshot(fx.db, tmp, meta)

    expect(snap.file.endsWith('.atlasbak')).toBe(true)
    expect(readFileSync(snap.file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(snap.bytes).toBe(readFileSync(snap.file).length)
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.counts).toEqual({ tickets: 0, orders: 0, order_lines: 0, products: 7, users: 0, z_reports: 0 })

    const manifest = JSON.parse(readFileSync(`${snap.file}.json`, 'utf8'))
    expect(manifest).toEqual({
      format: 'atlasbak',
      schemaVersion: migrations.length,
      appVersion: '0.1.0',
      installationId: 'inst-test',
      createdAt: '2026-10-22T10:00:00.000Z',
      kind: 'manual',
      sha256: snap.sha256,
      counts: snap.counts
    })

    const verified = await verifySnapshot(snap.file, tmp)
    expect(verified).toEqual({ ok: true, value: manifest })
    // Only the snapshot and its manifest remain: the raw copy and the verify scratch are gone.
    expect(readdirSync(tmp).sort()).toEqual([basename(snap.file), `${basename(snap.file)}.json`])
  })

  it('checks a live copy with quick_check and a dated copy with the full integrity_check', async () => {
    const pragma = vi.spyOn(BetterSqlite3.prototype, 'pragma')
    try {
      const checks = (): string[] =>
        pragma.mock.calls.map((c) => String(c[0])).filter((p) => p === 'quick_check' || p === 'integrity_check')
      await createSnapshot(fx.db, tmp, { ...meta, kind: 'live' })
      expect(checks()).toEqual(['quick_check'])
      pragma.mockClear()
      await createSnapshot(fx.db, tmp, meta)
      expect(checks()).toEqual(['integrity_check'])
    } finally {
      pragma.mockRestore()
    }
  })

  it('fails verification when one byte of the archive changes', async () => {
    const snap = await createSnapshot(fx.db, tmp, meta)
    const bytes = readFileSync(snap.file)
    const at = Math.floor(bytes.length / 2)
    bytes[at] = (bytes[at] ?? 0) ^ 0xff
    writeFileSync(snap.file, bytes)

    const verified = await verifySnapshot(snap.file, tmp)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('backup_checksum_mismatch')
  })

  it('fails verification when the archive is valid but the counts do not match the manifest', async () => {
    const snap = await createSnapshot(fx.db, tmp, meta)
    const manifest = JSON.parse(readFileSync(`${snap.file}.json`, 'utf8'))
    manifest.counts.products = 8
    writeFileSync(`${snap.file}.json`, JSON.stringify(manifest))

    const verified = await verifySnapshot(snap.file, tmp)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('backup_counts_mismatch')
  })

  it('fails verification when the manifest is missing', async () => {
    const snap = await createSnapshot(fx.db, tmp, meta)
    writeFileSync(`${snap.file}.json`, '{ not json')

    const verified = await verifySnapshot(snap.file, tmp)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('backup_manifest_invalid')
  })
})
