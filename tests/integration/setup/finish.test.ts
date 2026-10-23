import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUSINESS_TYPES } from '../../../src/main/domain/config/settings-registry'
import { loadTemplate } from '../../../src/main/domain/config/template'
import { openDatabase, openDatabaseReadOnly } from '../../../src/main/infrastructure/db/connection'
import { migrate } from '../../../src/main/infrastructure/db/migrate'
import { createSettingsRepo } from '../../../src/main/infrastructure/db/repos/settings-repo'
import { readInstallation } from '../../../src/main/infrastructure/fs/installation'
import { verifySecret } from '../../../src/main/infrastructure/security/password'
import { isManagerPermissions } from '../../../src/main/domain/users/profile'
import { completeDraft, MANAGER_PASSWORD, MANAGER_PIN, setupEnv, TECH_CODE, testSetupService, type SetupEnv } from '../../helpers/setup'

let env: SetupEnv
beforeEach(() => {
  env = setupEnv()
})
afterEach(() => env.cleanup())

const count = (file: string, sql: string): number => {
  const db = openDatabaseReadOnly(file)
  try {
    return db.prepare(sql).pluck().get() as number
  } finally {
    db.close()
  }
}

describe('finishSetup', () => {
  it.each(BUSINESS_TYPES)('seeds the %s template: catalogue, floor, profiles, a manager, printers, backup', async (id) => {
    const template = loadTemplate(id)
    const service = testSetupService({ paths: env.paths })
    expect(service.saveDraft(completeDraft(env, { businessType: id, modules: template.modules })).ok).toBe(true)

    const done = await service.finishSetup()
    expect(done).toMatchObject({ ok: true, value: { warnings: [] } })
    if (!done.ok) return

    const file = env.paths.dbFile
    expect(count(file, 'SELECT COUNT(*) FROM categories')).toBe(template.categories.length)
    expect(count(file, 'SELECT COUNT(*) FROM products')).toBe(template.products.length)
    expect(count(file, 'SELECT COUNT(*) FROM modifier_groups')).toBe(template.modifierGroups.length)
    expect(count(file, 'SELECT COUNT(*) FROM menus')).toBe(template.menus.length)
    expect(count(file, 'SELECT COUNT(*) FROM rooms')).toBe(template.rooms.length)
    expect(count(file, 'SELECT COUNT(*) FROM tables')).toBe(template.tables.length)
    expect(count(file, 'SELECT COUNT(*) FROM payment_methods')).toBe(template.paymentMethods.length)
    expect(count(file, 'SELECT COUNT(*) FROM profiles')).toBe(3)
    expect(count(file, 'SELECT COUNT(*) FROM users')).toBe(1)
    expect(count(file, 'SELECT COUNT(*) FROM printers')).toBe(3)
    expect(count(file, 'SELECT COUNT(*) FROM category_printers')).toBe(Object.keys(template.printersRouting).length)

    // The restaurant: 2 rooms, 20 tables, plenty of products.
    if (id === 'restaurant') {
      expect(template.rooms).toHaveLength(2)
      expect(count(file, 'SELECT COUNT(*) FROM tables')).toBe(20)
      expect(count(file, 'SELECT COUNT(*) FROM products')).toBeGreaterThanOrEqual(30)
    }

    // installation.json says the setup is complete; the draft and the attempt marker are gone.
    expect(readInstallation(env.paths)).toMatchObject({ installationId: done.value.installationId, appVersion: '0.1.0-test' })
    expect(readInstallation(env.paths)?.setupCompletedAt).toBeTruthy()
    expect(existsSync(join(env.paths.config, 'wizard-draft.json'))).toBe(false)
    expect(existsSync(join(env.paths.config, 'setup-attempt.json'))).toBe(false)

    const db = openDatabase(file)
    try {
      // The settings follow the draft; secrets are hashed.
      const settings = createSettingsRepo(db)
      expect(settings.get('business.legal').ice).toBe('001234567000012')
      expect(settings.get('modules')).toEqual(template.modules)
      expect(settings.get('business.type')).toBe(id)
      expect(verifySecret(TECH_CODE, settings.get('tech.codeHash')!)).toBe(true)
      const manager = db.prepare('SELECT u.*, p.permissions_json FROM users u JOIN profiles p ON p.id = u.profile_id').get() as {
        pin_hash: string
        password_hash: string
        username: string
        permissions_json: string
      }
      expect(manager.username).toBe('karim')
      expect(verifySecret(MANAGER_PIN, manager.pin_hash)).toBe(true)
      expect(verifySecret(MANAGER_PASSWORD, manager.password_hash)).toBe(true)
      expect(manager.pin_hash).not.toContain(MANAGER_PIN)
      expect(isManagerPermissions(JSON.parse(manager.permissions_json))).toBe(true)

      // One destination, with its creation time and key; one full backup, delivered to it and kept locally.
      const destination = db.prepare('SELECT * FROM backup_destinations').get() as { created_at: string; target_key: string; path: string; last_ok_at: string }
      expect(destination.path).toBe(env.backupDir)
      expect(destination.created_at).toBeTruthy()
      expect(destination.target_key).toBeTruthy()
      expect(destination.last_ok_at).toBeTruthy()
      expect(readFileSync(join(env.backupDir, 'AtlasBackup', '.atlas-target'), 'utf8').trim()).toBe(destination.target_key)
      const runs = db.prepare('SELECT kind, results_json FROM backup_runs').all() as { kind: string; results_json: string }[]
      expect(runs.filter((r) => r.kind === 'full')).toHaveLength(1)
      const results = JSON.parse(runs.find((r) => r.kind === 'full')!.results_json) as { ok: boolean }[]
      expect(results).toHaveLength(1)
      expect(results[0]!.ok).toBe(true)
    } finally {
      db.close()
    }
    expect(readdirSync(join(env.backupDir, 'AtlasBackup', 'full')).filter((n) => n.endsWith('.atlasbak'))).toHaveLength(1)
    expect(readdirSync(env.paths.backups).some((n) => n.endsWith('.atlasbak'))).toBe(true)
  })

  it('honours an explicit routing: only the route the draft names is created', async () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env, { routing: { plats: ['bar'] } }))
    expect((await service.finishSetup()).ok).toBe(true)
    const db = openDatabaseReadOnly(env.paths.dbFile)
    const rows = db
      .prepare(
        `SELECT c.name_json, p.name FROM category_printers cp
         JOIN categories c ON c.id = cp.category_id JOIN printers p ON p.id = cp.printer_id`
      )
      .all() as { name_json: string; name: string }[]
    db.close()
    // Only what the draft said: one route.
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.name_json).fr).toBe('Plats')
    expect(rows[0]!.name).toBe('Bar')
  })

  it('refuses a missing ICE as invalid_input on legal.ice, and creates nothing', async () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env))
    const draftFile = join(env.paths.config, 'wizard-draft.json')
    const draft = JSON.parse(readFileSync(draftFile, 'utf8'))
    draft.legal.ice = ''
    writeFileSync(draftFile, JSON.stringify(draft))
    expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'legal.ice' } } })
    expect(existsSync(env.paths.dbFile)).toBe(false)
    expect(existsSync(draftFile)).toBe(true)
  })

  it.each([
    ['a duplicate PIN', { users: [{ displayName: 'A', pin: '1234', profileCode: 'gerant', username: 'karim', password: MANAGER_PASSWORD }, { displayName: 'B', pin: '1234', profileCode: 'caissier' }] }, 'users.1.pin'],
    ['a short password', { users: [{ displayName: 'A', pin: '1234', profileCode: 'gerant', username: 'karim', password: 'short' }] }, 'users.0.password'],
    ['no manager with a password', { users: [{ displayName: 'A', pin: '1234', profileCode: 'caissier' }] }, 'users'],
    ['a technician code equal to a PIN', { technicianCode: '123456', users: [{ displayName: 'A', pin: '123456', profileCode: 'gerant', username: 'karim', password: MANAGER_PASSWORD }] }, 'technicianCode'],
    ['a printer with no address', { printers: [{ tempId: 'x', name: 'USB', kind: 'network' as const, address: '', widthMm: 80 as const, lang: 'fr' as const, raster: false, role: 'receipt' as const, active: true }] }, 'printers.0.address'],
    ['a route to an unknown printer', { routing: { plats: ['ghost'] } }, 'routing.plats']
  ])('refuses %s', async (_name, patch, field) => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env, patch))
    expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field } } })
    expect(existsSync(env.paths.dbFile)).toBe(false)
  })

  it('removes the database and keeps the draft when the installation cannot be written, and a retry then works', async () => {
    let fail = true
    const service = testSetupService({
      paths: env.paths,
      writeInstallation: (paths, installation) => {
        if (fail) throw new Error('disk full')
        // the real one
        writeFileSync(join(paths.config, 'installation.json'), JSON.stringify(installation))
      }
    })
    service.saveDraft(completeDraft(env))

    expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'setup_failed', params: { stage: 'installation' } } })
    expect(existsSync(env.paths.dbFile)).toBe(false)
    expect(existsSync(`${env.paths.dbFile}-wal`)).toBe(false)
    expect(existsSync(join(env.paths.config, 'setup-attempt.json'))).toBe(false)
    expect(service.getDraft().draft.legal.ice).toBe('001234567000012')
    expect(existsSync(join(env.paths.config, 'wizard-draft.json'))).toBe(true)

    fail = false
    expect(await service.finishSetup()).toMatchObject({ ok: true })
    expect(existsSync(env.paths.dbFile)).toBe(true)
    expect(existsSync(join(env.paths.config, 'wizard-draft.json'))).toBe(false)
  })

  describe('a database that is already there', () => {
    const migratedDb = (paths = env.paths): void => {
      const db = openDatabase(paths.dbFile)
      migrate(db)
      db.close()
    }
    const addTicket = (): void => {
      const db = openDatabase(env.paths.dbFile)
      db.prepare(
        `INSERT INTO tickets (id, kind, number, label, order_id, day_id, closed_at, user_id, total_cents, snapshot_json)
         VALUES ('t1', 'sale', 1, '000001', 'o', 'd', 'x', 'u', 100, '{}')`
      ).run()
      db.close()
    }

    it('is somebody\'s data without the attempt marker: existing_data, the file is untouched', async () => {
      migratedDb()
      const before = readFileSync(env.paths.dbFile)
      const service = testSetupService({ paths: env.paths })
      service.saveDraft(completeDraft(env))
      expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'existing_data' } })
      expect(readFileSync(env.paths.dbFile).equals(before)).toBe(true)
    })

    it('is somebody\'s data when it holds tickets, marker or not', async () => {
      migratedDb()
      addTicket()
      writeFileSync(join(env.paths.config, 'setup-attempt.json'), '{"startedAt":"x"}')
      const service = testSetupService({ paths: env.paths })
      service.saveDraft(completeDraft(env))
      expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'existing_data' } })
      expect(count(env.paths.dbFile, 'SELECT COUNT(*) FROM tickets')).toBe(1)
    })

    it('is the leftover of a stopped attempt with the marker and no ticket: replaced (a power cut before the end is retried)', async () => {
      migratedDb()
      writeFileSync(join(env.paths.config, 'setup-attempt.json'), '{"startedAt":"x"}')
      const service = testSetupService({ paths: env.paths })
      service.saveDraft(completeDraft(env))
      expect(await service.finishSetup()).toMatchObject({ ok: true })
      expect(count(env.paths.dbFile, 'SELECT COUNT(*) FROM users')).toBe(1)
    })
  })

  it('keeps the key of a destination across a failed attempt, so the marker it wrote still matches', async () => {
    let fail = true
    const service = testSetupService({
      paths: env.paths,
      writeInstallation: (paths, installation) => {
        if (fail) throw new Error('disk full')
        writeFileSync(join(paths.config, 'installation.json'), JSON.stringify(installation))
      }
    })
    service.saveDraft(completeDraft(env))
    await service.finishSetup()
    const key = service.getDraft().draft.backups[0]!.targetKey
    expect(key).toBeTruthy()
    fail = false
    expect(await service.finishSetup()).toMatchObject({ ok: true })
    expect(readFileSync(join(env.backupDir, 'AtlasBackup', '.atlas-target'), 'utf8').trim()).toBe(key)
  })

  it('is refused while another finish is running', async () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env))
    const [first, second] = await Promise.all([service.finishSetup(), service.finishSetup()])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    const refused = first.ok ? second : first
    expect(refused).toMatchObject({ error: { code: 'setup_in_progress' } })
  })

  it('applies an Excel/CSV catalogue: preview, then the rows become the catalogue', async () => {
    const { csvBuffer, SAMPLE } = await import('../../helpers/sheets')
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env, { catalogSource: 'import' }))
    const preview = service.previewImport(csvBuffer(SAMPLE), 'produits.csv')
    expect(preview.errors).toEqual([])
    expect(preview.rows).toHaveLength(3)
    expect(service.getDraft().draft.importFile).toMatch(/wizard-import\.csv$/)

    expect(await service.finishSetup()).toMatchObject({ ok: true })
    expect(count(env.paths.dbFile, 'SELECT COUNT(*) FROM products')).toBe(3)
    expect(count(env.paths.dbFile, 'SELECT COUNT(*) FROM categories')).toBe(2)
    // Profiles, payment methods and the rest still come from the business template.
    expect(count(env.paths.dbFile, 'SELECT COUNT(*) FROM profiles')).toBe(3)
    expect(existsSync(join(env.paths.config, 'wizard-import.csv'))).toBe(false)
  })

  it('refuses an import whose sheet has errors, and a draft that points at no preview', async () => {
    const { csvBuffer } = await import('../../helpers/sheets')
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env, { catalogSource: 'import' }))
    expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'importFile' } } })
    const preview = service.previewImport(csvBuffer([['Boissons', 'Café', '', '', 'pas un prix', '10', '', 'non', '', '']]), 'produits.csv')
    expect(preview.errors.length).toBeGreaterThan(0)
    expect(service.getDraft().draft.importFile).toBeUndefined()
  })

  it('installs the logo under media/ and stores its relative path', async () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft(completeDraft(env))
    expect(service.pickLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg').ok).toBe(true)
    expect(service.pickLogo(Buffer.from('x'), 'logo.exe')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await service.finishSetup()).toMatchObject({ ok: true })
    expect(existsSync(join(env.paths.media, 'logo.svg'))).toBe(true)
    const db = openDatabaseReadOnly(env.paths.dbFile)
    expect(createSettingsRepo(db).get('business.logo')).toBe('media/logo.svg')
    db.close()
  })
})

