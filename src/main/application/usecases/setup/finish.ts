import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { newId } from '@shared/ids'
import type { ImportRow } from '@shared/dto'
import type { WizardDraft } from '@shared/setup/draft'
import { normalizeUsername } from '../../../domain/users/credentials'
import {
  isPortableSettingKey,
  isSettingKey,
  type SettingKey
} from '../../../domain/config/settings-registry'
import { createBackupEngine } from '../../../infrastructure/backup/engine'
import { targetsFromDestinations } from '../../../infrastructure/backup/targets'
import { removeDbFiles } from '../../../infrastructure/backup/snapshot'
import { openDatabase, openDatabaseReadOnly, type Database } from '../../../infrastructure/db/connection'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { migrate } from '../../../infrastructure/db/migrate'
import { createCatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import { createSettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import { createUsersRepo } from '../../../infrastructure/db/repos/users-repo'
import { createUnitOfWork } from '../../../infrastructure/db/uow'
import { writeFileAtomic } from '../../../infrastructure/fs/atomic'
import { writeInstallation as writeInstallationFile } from '../../../infrastructure/fs/installation'
import { parseCatalogSheet } from '../../../infrastructure/import/catalog-sheet'
import { hashSecretAsync } from '../../../infrastructure/security/password'
import type { Logger } from '../../../logger'
import type { DataPaths } from '../../../paths'
import { AppErrorException } from '../../errors'
import type { Clock, EventBus } from '../../ports'
import { invalidInput } from '../users/outcome'
import type { DraftStore } from './draft-store'
import { installTemplateImages } from './media'
import { sectionsFor, sourceOf, type SetupSource } from './sections'
import { seedCatalog, seedFloor, seedImport, seedPaymentMethods, seedPrinters, seedProfiles, seedRouting } from './seed'
import { ensureTargets } from './targets'
import { validateDraft } from './validate'

export interface FinishDeps {
  paths: DataPaths
  clock: Clock
  bus: EventBus
  log: Logger
  appVersion: string
  store: DraftStore
  /** Registers (or not) the start with the OS: Electron's, injected so that this stays testable. */
  setAutostart(enabled: boolean): void
  /** Where the template illustrations are (`<template>/<code>.webp`); without it a template catalogue has no photos. */
  templateMediaDir?: string
  /** Writes `installation.json`. Replaceable by tests to make the setup fail at that point. */
  writeInstallation?: typeof writeInstallationFile
}

export interface FinishValue {
  installationId: string
  warnings: string[]
}

/** Tickets in a database file, or null when it cannot be read at all (it may well hold data). A schema without the table has none. */
function countTickets(file: string): number | null {
  let db: Database
  try {
    db = openDatabaseReadOnly(file)
  } catch {
    return null
  }
  try {
    return db.prepare('SELECT COUNT(*) FROM tickets').pluck().get() as number
  } catch (error) {
    return /no such table/i.test(String(error)) ? 0 : null
  } finally {
    db.close()
  }
}

/** The rows of the import sheet the draft refers to; the sheet is read again, it may have changed since the preview. */
function importRows(draft: WizardDraft): ImportRow[] {
  const file = draft.importFile!
  const parsed = parseCatalogSheet(readFileSync(file), file, draft.vatRates)
  if (parsed.errors.length > 0) throw invalidInput('importFile', 'the sheet has errors')
  if (parsed.rows.length === 0) throw invalidInput('importFile', 'the sheet has no product')
  return parsed.rows
}

/** The settings to store: the template's or profile's, then everything the wizard asked for. */
function settingEntries(draft: WizardDraft, source: SetupSource, techHash: string, logo: string | null): [SettingKey, unknown][] {
  const base = draft.catalogSource === 'profile' && source.profile ? source.profile.settings : source.template.settings
  const entries = new Map<SettingKey, unknown>()
  for (const [key, value] of Object.entries(base)) if (isSettingKey(key) && isPortableSettingKey(key)) entries.set(key, value)
  const own: [SettingKey, unknown][] = [
    ['business.legal', draft.legal],
    ['business.type', draft.businessType],
    ['business.logo', logo],
    ['modules', draft.modules],
    ['vat.rates', draft.vatRates],
    ['receipt.lang', draft.lang.receipt],
    ['receipt.header', draft.receiptHeader],
    ['receipt.footer', draft.receiptFooter],
    ['ui.defaultLang', draft.lang.staffDefault],
    ['kiosk.enabled', draft.kiosk],
    ['autostart.enabled', draft.autostart],
    ['display.customerEnabled', draft.customerDisplay],
    ['backoffice.port', draft.backofficePort],
    ['backup.continuous', draft.backupSchedule.continuous],
    ['backup.onClose', draft.backupSchedule.onClose],
    ['backup.retentionDays', draft.backupSchedule.retentionDays],
    ['tech.codeHash', techHash]
  ]
  for (const [key, value] of own) entries.set(key, value)
  return [...entries]
}

/** Category -> printers: the draft's routing, or (a template catalogue, nothing chosen) the template's default by printer role. */
function routingOf(draft: WizardDraft, source: SetupSource): Record<string, string[]> {
  if (Object.keys(draft.routing).length > 0 || draft.catalogSource !== 'template') return draft.routing
  const routing: Record<string, string[]> = {}
  for (const [category, role] of Object.entries(source.template.printersRouting)) {
    const printer = draft.printers.find((p) => p.active && p.role === role)
    if (printer) routing[category] = [printer.tempId]
  }
  return routing
}

/** The logo the wizard kept, copied to `media/logo.<ext>`; the setting holds the path relative to the data directory. */
function installLogo(draft: WizardDraft, paths: DataPaths): string | null {
  if (!draft.logoPath || !existsSync(draft.logoPath)) return null
  const name = `logo${extname(draft.logoPath).toLowerCase()}`
  mkdirSync(paths.media, { recursive: true })
  copyFileSync(draft.logoPath, join(paths.media, name))
  return `media/${name}`
}

/**
 * The end of the wizard: validates the draft, creates the database and seeds it in one transaction,
 * writes `installation.json`, takes the first full backup, registers the start with the OS and forgets the
 * draft. Safe to run again after any failure or power cut:
 * - before the database is created an attempt marker (`config/setup-attempt.json`) is written; a database
 *   found later WITH the marker and without any ticket is the leftover of a stopped attempt and is deleted,
 *   a database without the marker (or with tickets, or unreadable) is somebody's data: `existing_data`,
 *   nothing touched;
 * - a failure before `installation.json` is written deletes the database and the marker and keeps the draft;
 * - after it the setup is complete: a failing backup or auto-start is a warning, not an undoing.
 * Throws `AppErrorException` (`invalid_input`, `legal_not_confirmed`, `existing_data`, `setup_failed`...).
 */
export async function runFinish(deps: FinishDeps): Promise<FinishValue> {
  const { paths, clock, bus, log, store } = deps
  const writeInstallation = deps.writeInstallation ?? writeInstallationFile

  const stored = store.read()
  const source = sourceOf(stored, store.loadedProfile())
  validateDraft(stored, source, store)
  const sections = sectionsFor(stored, source)
  const rows = stored.catalogSource === 'import' ? importRows(stored) : null

  // A database already there: a stopped attempt of ours (marker, no ticket), or somebody's data. Decided before
  // anything is written anywhere.
  const leftover = existsSync(paths.dbFile)
  if (leftover && (!existsSync(store.attemptFile) || countTickets(paths.dbFile) !== 0)) throw new AppErrorException('existing_data')

  // Every secret is hashed before the transaction (it is synchronous).
  const [techHash, ...hashes] = await Promise.all([
    hashSecretAsync(stored.technicianCode),
    ...stored.users.flatMap((u) => [hashSecretAsync(u.pin), u.password ? hashSecretAsync(u.password) : Promise.resolve(null)])
  ])
  const hashesOf = (i: number): { pin: string; password: string | null } => ({ pin: hashes[i * 2]!, password: hashes[i * 2 + 1] ?? null })

  // A destination without a key gets one now, written to the draft BEFORE its marker: a retry reuses it.
  const backups = stored.backups.map((b) => ({ ...b, targetKey: b.targetKey || newId() }))
  const draft: WizardDraft = { ...stored, backups }
  if (backups.some((b, i) => b.targetKey !== stored.backups[i]!.targetKey)) store.write(draft)
  await ensureTargets(backups)
  const logo = installLogo(draft, paths)
  // Only a template catalogue has illustrations (an import, an empty catalogue or a profile has none).
  const images = draft.catalogSource === 'template' ? installTemplateImages(source.template, deps.templateMediaDir, paths, log) : undefined

  // The database that is already there is the leftover of a stopped attempt, which is replaced.
  if (leftover) await removeDbFiles(paths.dbFile)
  writeFileAtomic(store.attemptFile, JSON.stringify({ startedAt: clock.now().toISOString() }))

  let stage: 'database' | 'seed' | 'installation' = 'database'
  let opened: Database | null = null
  let installationId = ''
  const startedAt = clock.now().toISOString()
  try {
    const db = openDatabase(paths.dbFile)
    opened = db
    migrate(db)
    stage = 'seed'
    const uow = createUnitOfWork(db, clock, bus)
    const settings = createSettingsRepo(db)
    const usersRepo = createUsersRepo(db)
    const catalogRepo = createCatalogRepo(db)
    uow.run((tx) => {
      for (const [key, value] of settingEntries(draft, source, techHash!, logo)) settings.set(tx, key, value as never)
      const profileIds = seedProfiles(tx, usersRepo, sections.profiles)
      seedPaymentMethods(tx, sections.paymentMethods)
      seedFloor(tx, sections.rooms, sections.tables)
      const categoryIds = rows ? seedImport(tx, catalogRepo, rows) : seedCatalog(tx, catalogRepo, sections, images)
      const printerIds = seedPrinters(tx, draft.printers)
      seedRouting(tx, routingOf(draft, source), categoryIds, printerIds)
      draft.users.forEach((user, i) => {
        const username = user.username?.trim() ? normalizeUsername(user.username) : null
        const { pin, password } = hashesOf(i)
        usersRepo.insertUser(tx, {
          id: newId(),
          displayName: user.displayName.trim(),
          pinHash: pin!,
          username,
          passwordHash: username === null ? null : password,
          profileId: profileIds.get(user.profileCode)!,
          lang: draft.lang.staffDefault,
          active: true
        })
      })
      const insertDestination = tx.db.prepare(
        'INSERT INTO backup_destinations (id, role, path, label, target_key, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      )
      for (const b of draft.backups) insertDestination.run(newId(), b.role, b.path.trim(), b.label.trim(), b.targetKey, startedAt)
      appendEvent(
        tx.db,
        { type: 'setup.completed', entity: 'installation', data: { businessType: draft.businessType, catalogSource: draft.catalogSource } },
        tx.clock
      )
    })

    stage = 'installation'
    installationId = newId()
    const now = clock.now().toISOString()
    writeInstallation(paths, { installationId, createdAt: now, setupCompletedAt: now, appVersion: deps.appVersion })
  } catch (error) {
    // Not installed: nothing of this attempt may stay, so that the next one starts clean.
    try {
      opened?.close()
    } catch {
      // the files are deleted next
    }
    await removeDbFiles(paths.dbFile)
    rmSync(store.attemptFile, { force: true })
    log.error('setup.failed', { stage, message: error instanceof Error ? error.message : String(error) })
    if (error instanceof AppErrorException) throw error
    throw new AppErrorException('setup_failed', { stage, message: error instanceof Error ? error.message : String(error) })
  }

  // Installed. From here on nothing undoes it.
  const db = opened!
  rmSync(store.attemptFile, { force: true })
  const warnings: string[] = []
  try {
    const engine = createBackupEngine({
      db,
      paths,
      targets: () => targetsFromDestinations(db),
      clock,
      settings: createSettingsRepo(db),
      log: log.info,
      eventBus: bus,
      appVersion: deps.appVersion
    })
    const run = await engine.runFull('full', 'setup')
    if (!run.ok) warnings.push('backup_failed')
    else for (const r of run.results) if (!r.ok) warnings.push(`backup_target:${r.targetId}:${r.error ?? 'failed'}`)
    await engine.idle()
  } catch (error) {
    log.error('setup.first_backup_failed', { message: String(error) })
    warnings.push('backup_failed')
  }
  try {
    deps.setAutostart(draft.autostart)
  } catch (error) {
    log.error('setup.autostart_failed', { message: String(error) })
    warnings.push('autostart_failed')
  }
  try {
    store.clear()
  } catch (error) {
    log.warn('setup.draft_not_deleted', { message: String(error) })
  }
  try {
    db.close()
  } catch (error) {
    log.warn('setup.db_close_failed', { message: String(error) })
  }
  log.info('setup.finished', { installationId, warnings })
  return { installationId, warnings }
}
