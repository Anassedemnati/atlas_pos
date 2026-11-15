import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PrinterDraft } from '../../../src/shared/setup/draft'
import { setupEnv, testSetupService, type SetupEnv } from '../../helpers/setup'

let env: SetupEnv
beforeEach(() => {
  env = setupEnv()
})
afterEach(() => env.cleanup())

const virtual: PrinterDraft = { tempId: 'v', name: 'Caisse virtuelle', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }

describe('testing a printer of the draft', () => {
  it('writes the test page of a virtual printer to prints/', async () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft({ legal: { raisonSociale: 'X', nomCommercial: 'Café Atlas', adresse: 'a', ville: 'v', telephone: 't', ice: '001234567000012', if: '1', rc: '1', patente: '1' } })
    expect(await service.testPrinter(virtual)).toEqual({ ok: true, value: null })
    const files = readdirSync(env.paths.prints)
    const bin = files.find((f) => f.endsWith('-caisse-virtuelle.bin'))
    expect(bin).toBeDefined()
    // ESC/POS bytes of the French page: the title, the business name and the printer's name.
    const text = readFileSync(join(env.paths.prints, bin!)).toString('latin1')
    expect(text).toContain('Atlas')
    expect(text).toContain("TEST D'IMPRESSION")
    expect(text).toContain('Caisse virtuelle')
  })

  it('pulses the drawer', async () => {
    const service = testSetupService({ paths: env.paths })
    expect((await service.testPrinter(virtual, 'drawer')).ok).toBe(true)
    const bin = readdirSync(env.paths.prints).find((f) => f.endsWith('.bin'))!
    // ESC p 0 25 250
    expect(readFileSync(join(env.paths.prints, bin)).includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(true)
  })

  it('reports a printer that cannot be reached, without throwing', async () => {
    const service = testSetupService({ paths: env.paths })
    const result = await service.testPrinter({ ...virtual, kind: 'network', address: '127.0.0.1:1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'print_failed' } })
    expect(await service.testPrinter({ ...virtual, kind: 'network', address: '' })).toMatchObject({ ok: false, error: { code: 'print_failed' } })
  })
})

describe('testing a backup destination', () => {
  it('writes the marker with a new key, and keeps it when tested again with that key', async () => {
    const service = testSetupService({ paths: env.paths })
    const first = await service.testBackupTarget({ role: 'disk', path: env.backupDir, label: 'Disque 2' })
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    const marker = join(env.backupDir, 'AtlasBackup', '.atlas-target')
    expect(readFileSync(marker, 'utf8').trim()).toBe(first.value.targetKey)
    expect(first.value.writableBytes).toBeGreaterThan(0)
    expect(readdirSync(join(env.backupDir, 'AtlasBackup')).filter((n) => n.startsWith('.probe'))).toEqual([])

    expect(await service.testBackupTarget({ role: 'disk', path: env.backupDir, targetKey: first.value.targetKey })).toMatchObject({
      ok: true,
      value: { targetKey: first.value.targetKey }
    })
  })

  it('refuses a marker that holds another key, unless told to overwrite', async () => {
    const service = testSetupService({ paths: env.paths })
    const first = await service.testBackupTarget({ role: 'nas', path: env.backupDir })
    if (!first.ok) throw new Error('first test failed')

    // Another installation's drive, or this one's earlier attempt: a new key does not take it over.
    const conflict = await service.testBackupTarget({ role: 'nas', path: env.backupDir })
    expect(conflict).toMatchObject({ ok: false, error: { code: 'marker_conflict', params: { existingKey: first.value.targetKey } } })
    expect(readFileSync(join(env.backupDir, 'AtlasBackup', '.atlas-target'), 'utf8').trim()).toBe(first.value.targetKey)

    const taken = await service.testBackupTarget({ role: 'nas', path: env.backupDir, overwrite: true })
    expect(taken).toMatchObject({ ok: true })
    if (!taken.ok) return
    expect(taken.value.targetKey).not.toBe(first.value.targetKey)
    expect(readFileSync(join(env.backupDir, 'AtlasBackup', '.atlas-target'), 'utf8').trim()).toBe(taken.value.targetKey)
  })

  it('does not create a folder that is not there (an unmounted drive)', async () => {
    const gone = join(mkdtempSync(join(tmpdir(), 'atlas-gone-')), 'mnt')
    const service = testSetupService({ paths: env.paths })
    expect(await service.testBackupTarget({ role: 'usb', path: gone })).toMatchObject({ ok: false, error: { code: 'backup_target_unavailable' } })
    expect(() => readdirSync(gone)).toThrow()
    rmSync(join(gone, '..'), { recursive: true, force: true })
  })
})
