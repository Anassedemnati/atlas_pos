import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listBackups } from '../../../src/main/infrastructure/backup/restore'
import { body, startHttp, type Http } from './harness'

let h: Http
beforeAll(async () => {
  h = await startHttp()
  expect((await h.login()).statusCode).toBe(200)
})
afterAll(async () => {
  await h.close()
})

interface Entry {
  id: string
  fileName: string
  source: string
  file?: string
}

describe('backups over HTTP', () => {
  it('runs a manual backup, lists it without any path, and downloads it', async () => {
    const run = await h.api('POST', '/api/backups/run')
    expect(run.statusCode).toBe(200)
    expect(body(run)).toMatchObject({ ok: true, value: { fileName: expect.stringMatching(/\.atlasbak$/) } })
    const listed = body<{ value: { status: { overall: string }; entries: Entry[] } }>(await h.api('GET', '/api/backups')).value
    expect(listed.status.overall).toMatch(/ok|warning|error/)
    expect(listed.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(listed)).not.toContain(h.paths.root)
    expect(listed.entries[0]).not.toHaveProperty('file')

    const entry = listed.entries[0]!
    const download = await h.api('GET', `/api/backups/${entry.id}/download`)
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain(entry.fileName)
    // A gzip file.
    expect([...download.rawPayload.subarray(0, 2)]).toEqual([0x1f, 0x8b])
    const manifest = await h.api('GET', `/api/backups/${entry.id}/download?part=manifest`)
    expect(body(manifest)).toMatchObject({ format: 'atlasbak' })
    // An id that is not in the listing reads nothing, whatever it holds.
    const forged = Buffer.from('local\n../../db/atlas.db').toString('base64url')
    expect((await h.api('GET', `/api/backups/${forged}/download`)).statusCode).toBe(404)
  })

  it('needs the word RESTAURER to restore, and an id from the listing', async () => {
    const entry = body<{ value: { entries: Entry[] } }>(await h.api('GET', '/api/backups')).value.entries[0]!
    for (const confirm of [undefined, '', 'restaurer', 'oui', 'RESTAURER ']) {
      const response = await h.api('POST', '/api/backups/restore', { id: entry.id, ...(confirm === undefined ? {} : { confirm }) })
      expect(response.statusCode, String(confirm)).toBe(400)
      expect(body(response)).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    }
    expect(h.afterRestore).not.toHaveBeenCalled()
    const unknown = await h.api('POST', '/api/backups/restore', { id: Buffer.from('local\nnope.atlasbak').toString('base64url'), confirm: 'RESTAURER' })
    expect(unknown.statusCode).toBe(404)
    expect(body(unknown)).toMatchObject({ error: { code: 'backup_not_found' } })
    expect(h.afterRestore).not.toHaveBeenCalled()
  })

  it('restores: the database is replaced, every session ends, the till reloads', async () => {
    // A change made after the backup must be gone after the restore.
    const before = body<{ value: { categories: unknown[] } }>(await h.api('GET', '/api/catalog')).value.categories.length
    await h.api('POST', '/api/backups/run')
    const entry = body<{ value: { entries: Entry[] } }>(await h.api('GET', '/api/backups')).value.entries[0]!
    expect((await h.api('POST', '/api/catalog/categories', { name: { fr: 'Après la sauvegarde' } })).statusCode).toBe(200)
    expect(body<{ value: { categories: unknown[] } }>(await h.api('GET', '/api/catalog')).value.categories).toHaveLength(before + 1)

    const restore = await h.api('POST', '/api/backups/restore', { id: entry.id, confirm: 'RESTAURER' })
    expect(restore.statusCode).toBe(200)
    expect(body(restore)).toMatchObject({ ok: true, value: { route: '#/login' } })
    expect(h.afterRestore).toHaveBeenCalledWith('#/login')
    // The browser's session is gone: signing in again works on the restored database.
    expect((await h.api('GET', '/api/catalog')).statusCode).toBe(401)
    expect((await h.login()).statusCode).toBe(200)
    expect(body<{ value: { categories: unknown[] } }>(await h.api('GET', '/api/catalog')).value.categories).toHaveLength(before)
    expect(readFileSync(h.paths.dbFile).length).toBeGreaterThan(0)
  })
})

describe('a restore started at the till', () => {
  it('signs every browser out too, even though the request did not come through HTTP', async () => {
    expect((await h.login()).statusCode).toBe(200)
    expect((await h.api('GET', '/api/catalog')).statusCode).toBe(200)
    await h.api('POST', '/api/backups/run')
    const [entry] = await listBackups([], h.paths.backups)
    // What the IPC `backup.restore` handler does: the runtime restores, the till's own sessions are cleared.
    const restored = await h.runtime.restore(entry!.file)
    expect(restored.ok).toBe(true)
    expect((await h.api('GET', '/api/catalog')).statusCode).toBe(401)
    expect((await h.login()).statusCode).toBe(200)
    expect((await h.api('GET', '/api/catalog')).statusCode).toBe(200)
  })
})
