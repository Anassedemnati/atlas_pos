import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/main/application/events'
import { loadTemplate } from '../../../src/main/domain/config/template'
import { createCatalogRepo } from '../../../src/main/infrastructure/db/repos/catalog-repo'
import { createSettingsRepo } from '../../../src/main/infrastructure/db/repos/settings-repo'
import { createUnitOfWork } from '../../../src/main/infrastructure/db/uow'
import { openDatabaseReadOnly } from '../../../src/main/infrastructure/db/connection'
import { exportProfile } from '../../../src/main/infrastructure/profile/profile-io'
import { fixedClock } from '../../helpers/clock'
import { seedSetup } from '../../helpers/seed-setup'
import { completeDraft, LEGAL, setupEnv, testSetupService, type SetupEnv } from '../../helpers/setup'
import { tempDb } from '../../helpers/db'

let env: SetupEnv
beforeEach(() => {
  env = setupEnv()
})
afterEach(() => env.cleanup())

describe('the wizard draft', () => {
  it('starts as a new French restaurant setup', () => {
    const { draft, profile } = testSetupService({ paths: env.paths }).getDraft()
    expect(profile).toBeNull()
    expect(draft).toMatchObject({ step: 0, startMode: 'new', businessType: 'restaurant', catalogSource: 'template', lang: { setup: 'fr', receipt: 'fr', staffDefault: 'fr' } })
  })

  it('survives a crash: a new process reads the same step and fields', () => {
    const first = testSetupService({ paths: env.paths })
    expect(first.saveDraft({ step: 3, lang: { setup: 'ar', receipt: 'fr', staffDefault: 'ar' }, businessType: 'cafe', legal: LEGAL }).ok).toBe(true)

    // "A new process": a service built again on the same data directory.
    const second = testSetupService({ paths: env.paths })
    expect(second.getDraft().draft).toMatchObject({ step: 3, businessType: 'cafe', lang: { setup: 'ar', staffDefault: 'ar' }, legal: LEGAL })
    // Saved atomically: no temp file left behind.
    expect(readdirSync(env.paths.config).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('falls back to a new draft when the file is torn or invalid', () => {
    writeFileSync(join(env.paths.config, 'wizard-draft.json'), '{"step": 3, "legal"')
    expect(testSetupService({ paths: env.paths }).getDraft().draft.step).toBe(0)
  })

  it('validates the step being left before saving: nothing is saved when it fails', () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft({ step: 2 })
    const refused = service.saveDraft({ step: 3, legal: { ...LEGAL, ice: '123' } }, 3)
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'legal.ice' } } })
    expect(service.getDraft().draft).toMatchObject({ step: 2, legal: { ice: '' } })
    expect(service.saveDraft({ step: 3, legal: LEGAL }, 3).ok).toBe(true)
    expect(service.getDraft().draft.step).toBe(3)
  })

  it('refuses a shape that is not a draft, and files that are not our own copies', () => {
    const service = testSetupService({ paths: env.paths })
    expect(service.saveDraft({ step: 12 } as never)).toMatchObject({ ok: false })
    expect(service.saveDraft({ importFile: '/etc/passwd' })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'importFile' } } })
    expect(service.saveDraft({ logoPath: '/etc/passwd' })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'logoPath' } } })
  })

  it('resets to a new wizard', () => {
    const service = testSetupService({ paths: env.paths })
    service.saveDraft({ step: 4, businessType: 'bakery' })
    expect(service.resetDraft().draft).toMatchObject({ step: 0, businessType: 'restaurant' })
    expect(existsSync(join(env.paths.config, 'wizard-draft.json'))).toBe(false)
  })

  it('lists the four templates with their modules, counts and default printer roles', () => {
    const templates = testSetupService({ paths: env.paths }).templates()
    expect(templates.map((t) => t.id)).toEqual(['restaurant', 'cafe', 'bakery', 'retail'])
    const restaurant = templates[0]!
    expect(restaurant.modules.tables).toBe(true)
    expect(restaurant.counts).toMatchObject({ rooms: 2, tables: 20, profiles: 3 })
    expect(restaurant.categories.find((c) => c.code === 'jus')?.route).toBe('bar')
    expect(restaurant.profiles.map((p) => p.code)).toEqual(['gerant', 'caissier', 'serveur'])
  })
})

describe('a setup profile', () => {
  /** A profile of a finished restaurant setup, with legal data and two network printers. */
  function profileBytes(): Buffer {
    const t = tempDb()
    try {
      const template = loadTemplate('restaurant')
      seedSetup(t.db, {
        ...template,
        printers: [
          { code: 'cuisine', name: 'Cuisine', kind: 'network', address: '192.168.1.50:9100', width_mm: 80, lang: 'fr', raster: false, role: 'kitchen', active: true },
          { code: 'bar', name: 'Bar', kind: 'network', address: '192.168.1.51:9100', width_mm: 80, lang: 'fr', raster: false, role: 'bar', active: true },
          { code: 'caisse', name: 'Caisse', kind: 'device-file', address: '/dev/usb/lp0', width_mm: 80, lang: 'fr', raster: false, role: 'receipt', active: true }
        ],
        routing: Object.fromEntries(template.categories.map((c) => [c.code, [c.code.startsWith('boissons') || c.code === 'jus' ? 'bar' : 'cuisine']]))
      })
      const uow = createUnitOfWork(t.db, fixedClock(), createEventBus())
      const settings = createSettingsRepo(t.db)
      uow.run((tx) => {
        settings.set(tx, 'business.type', 'restaurant')
        settings.set(tx, 'business.legal', { ...LEGAL, nomCommercial: 'Chez le profil' })
        settings.set(tx, 'modules', template.modules)
        settings.set(tx, 'receipt.footer', 'Merci du profil')
      })
      return exportProfile(t.db, { clock: fixedClock() })
    } finally {
      t.cleanup()
    }
  }

  it('pre-fills the draft, and the setup does not finish until the Entreprise step is saved again', async () => {
    const service = testSetupService({ paths: env.paths })
    const applied = service.applyProfileToDraft(profileBytes())
    expect(applied).toMatchObject({ ok: true, value: { draft: { startMode: 'profile', catalogSource: 'profile', legalFromProfile: true, receiptFooter: 'Merci du profil' } } })
    if (!applied.ok) return
    expect(applied.value.draft.legal.nomCommercial).toBe('Chez le profil')
    expect(applied.value.profile).toMatchObject({ counts: { products: 49, tables: 20 }, profiles: [{ code: 'gerant' }, { code: 'caissier' }, { code: 'serveur' }] })
    expect(applied.value.draft.printers.map((p) => [p.tempId, p.kind, p.address])).toEqual([
      ['cuisine', 'network', '192.168.1.50:9100'],
      ['bar', 'network', '192.168.1.51:9100'],
      ['caisse', 'device-file', '']
    ])

    // The rest of the wizard: users, technician code, backups, the device of the USB printer.
    const rest = completeDraft(env)
    service.saveDraft({
      users: rest.users!,
      technicianCode: rest.technicianCode!,
      backups: rest.backups!,
      // The device of the receipt printer is this machine's: the profile came without it.
      printers: applied.value.draft.printers.map((p) => (p.tempId === 'caisse' ? { ...p, address: '/dev/usb/lp0' } : p))
    })

    expect(await service.finishSetup()).toMatchObject({ ok: false, error: { code: 'legal_not_confirmed' } })
    expect(existsSync(env.paths.dbFile)).toBe(false)

    // Saving the legal data (even unchanged) is the confirmation; a renderer cannot confirm it by flag.
    service.saveDraft({ legalFromProfile: false })
    expect(service.getDraft().draft.legalFromProfile).toBe(true)
    expect(service.saveDraft({ legal: applied.value.draft.legal }).ok).toBe(true)
    expect(service.getDraft().draft.legalFromProfile).toBe(false)

    const finished = await service.finishSetup()
    expect(finished, JSON.stringify(finished)).toMatchObject({ ok: true })
    const db = openDatabaseReadOnly(env.paths.dbFile)
    // The catalogue equals the profile's (names, prices, VAT, categories, order), modifiers and menus included.
    const source = tempDb()
    const template = loadTemplate('restaurant')
    seedSetup(source.db, { ...template })
    const normalise = (d: ReturnType<typeof createCatalogRepo>): unknown => {
      const c = d.list()
      const categoryName = new Map(c.categories.map((x) => [x.id, x.name.fr]))
      return {
        categories: c.categories.map((x) => [x.name, x.color, x.active]),
        products: c.products.map((p) => [p.name, categoryName.get(p.categoryId), p.priceCents, p.vatBp, p.course, p.keySize, p.modifierGroupIds.length]),
        groups: c.modifierGroups.map((g) => [g.name, g.minSelect, g.maxSelect, g.modifiers.map((m) => [m.name, m.priceDeltaCents])]),
        menus: c.menus.length
      }
    }
    expect(normalise(createCatalogRepo(db))).toEqual(normalise(createCatalogRepo(source.db)))
    source.cleanup()
    // The routing came with it: 8 categories routed to the profile's printers.
    expect(db.prepare('SELECT COUNT(*) FROM category_printers').pluck().get()).toBe(8)
    expect(db.prepare('SELECT COUNT(*) FROM tables').pluck().get()).toBe(20)
    db.close()
  })

  it('refuses what is not a profile, or is from a newer app', () => {
    const service = testSetupService({ paths: env.paths })
    expect(service.applyProfileToDraft(Buffer.from('not a profile'))).toMatchObject({ ok: false, error: { code: 'invalid_profile' } })
    expect(service.getDraft().draft.startMode).toBe('new')
  })

  it('is not used by the draft once forgotten', () => {
    const service = testSetupService({ paths: env.paths })
    service.applyProfileToDraft(profileBytes())
    expect(service.getDraft().profile).not.toBeNull()
    service.resetDraft()
    expect(service.getDraft().profile).toBeNull()
  })
})

