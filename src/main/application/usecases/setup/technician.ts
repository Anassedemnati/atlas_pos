import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportRow, LogLineDto, TechChangesDto, TechProfileImportDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import type { WizardPatch } from '@shared/setup/draft'
import { MAX_PASSWORD_LENGTH } from '../../../domain/users/credentials'
import { isPortableSettingKey, isSettingKey, SETTINGS, type SettingKey } from '../../../domain/config/settings-registry'
import type { BackupEngine } from '../../../infrastructure/backup/engine'
import type { Database } from '../../../infrastructure/db/connection'
import { createCatalogRepo, type CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { Tx, UnitOfWork } from '../../../infrastructure/db/uow'
import { exportProfile, readProfile } from '../../../infrastructure/profile/profile-io'
import { hashSecretAsync } from '../../../infrastructure/security/password'
import type { DataPaths } from '../../../paths'
import { AppErrorException } from '../../errors'
import type { Clock } from '../../ports'
import { applyImport } from '../catalog/import-apply'
import { attempt, invalidInput } from '../users/outcome'
import { seedCatalog, seedFloor, seedPaymentMethods, wipeCatalogAndFloor } from './seed'
import { ensureTargets } from './targets'
import { checkPrinters, MIN_TECHNICIAN_CODE_LENGTH } from './validate'

export interface TechDeps {
  db: Database
  uow: UnitOfWork
  settings: SettingsRepo
  backup: Pick<BackupEngine, 'runFull'>
  paths: DataPaths
  clock: Clock
  appVersion: string
}

/** Every change of the technician menu starts from a verified full copy: no copy, no change. */
async function preChangeBackup(deps: TechDeps): Promise<void> {
  const run = await deps.backup.runFull('pre-change', 'tech')
  if (!run.ok) throw new AppErrorException(run.error.code, run.error.params)
}

const ordersExist = (db: Database): boolean => (db.prepare('SELECT EXISTS (SELECT 1 FROM orders)').pluck().get() as number) === 1

/** The settings a draft field stands for. */
function settingsOf(patch: WizardPatch, techHash: string | null): [SettingKey, unknown][] {
  const out: [SettingKey, unknown][] = []
  const add = (key: SettingKey, value: unknown): void => {
    if (value !== undefined) out.push([key, value])
  }
  add('business.legal', patch.legal)
  add('business.type', patch.businessType)
  add('vat.rates', patch.vatRates)
  add('receipt.header', patch.receiptHeader)
  add('receipt.footer', patch.receiptFooter)
  add('receipt.lang', patch.lang?.receipt)
  add('ui.defaultLang', patch.lang?.staffDefault)
  add('display.customerEnabled', patch.customerDisplay)
  add('kiosk.enabled', patch.kiosk)
  add('autostart.enabled', patch.autostart)
  add('backoffice.port', patch.backofficePort)
  add('backup.continuous', patch.backupSchedule?.continuous)
  add('backup.onClose', patch.backupSchedule?.onClose)
  add('backup.retentionDays', patch.backupSchedule?.retentionDays)
  add('modules', patch.modules)
  add('tech.codeHash', techHash ?? undefined)
  return out
}

/**
 * The technician menu's "apply": a `pre-change` backup first, then the parts of the draft it knows (see
 * `tech.applyChanges`). All or nothing. Printers are matched by id, so print jobs keep their printer.
 */
export function applyChanges(deps: TechDeps, patch: WizardPatch): Promise<Result<TechChangesDto>> {
  return attempt(async () => {
    const { db, uow, settings } = deps
    if (patch.printers) checkPrinters(patch.printers)
    if (patch.technicianCode !== undefined && (patch.technicianCode.length < MIN_TECHNICIAN_CODE_LENGTH || patch.technicianCode.length > MAX_PASSWORD_LENGTH)) {
      throw invalidInput('technicianCode', `${MIN_TECHNICIAN_CODE_LENGTH} characters at least`)
    }
    const known = new Set((db.prepare('SELECT id FROM printers').pluck().all() as string[]))
    for (const [category, ids] of Object.entries(patch.routing ?? {})) {
      const allowed = new Set([...known, ...(patch.printers ?? []).map((p) => p.tempId)])
      for (const id of ids) if (!allowed.has(id)) throw invalidInput(`routing.${category}`, `unknown printer "${id}"`)
    }

    // Destinations that are new get a key and are tested (the test writes the marker).
    const destinations = db.prepare('SELECT role, path, target_key AS key FROM backup_destinations').all() as { role: string; path: string; key: string }[]
    const backups = (patch.backups ?? []).map((b) => {
      const same = destinations.find((d) => d.role === b.role && d.path === b.path.trim())
      return { ...b, path: b.path.trim(), targetKey: same?.key ?? (b.targetKey || newId()), isNew: !same }
    })
    await ensureTargets(backups.filter((b) => b.isNew))
    const techHash = patch.technicianCode === undefined ? null : await hashSecretAsync(patch.technicianCode)
    // Every value against its rule BEFORE the backup: a refused change must leave no trace.
    const changes = settingsOf(patch, techHash)
    for (const [key, value] of changes) {
      const checked = SETTINGS[key].schema.safeParse(value)
      if (!checked.success) throw invalidInput([key, ...(checked.error.issues[0]?.path ?? [])].join('.'), checked.error.issues[0]?.message)
    }

    await preChangeBackup(deps)

    const applied = new Set<string>()
    uow.run((tx) => {
      for (const [key, value] of changes) {
        settings.set(tx, key, value as never)
        applied.add(key === 'modules' ? 'modules' : key === 'tech.codeHash' ? 'technicianCode' : 'settings')
      }

      let printerIds = new Map<string, string>()
      if (patch.printers) {
        applied.add('printers')
        const existing = new Set(tx.db.prepare('SELECT id FROM printers').pluck().all() as string[])
        const insert = tx.db.prepare('INSERT INTO printers (id, name, kind, address, width_mm, lang, raster, role, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        const update = tx.db.prepare('UPDATE printers SET name = ?, kind = ?, address = ?, width_mm = ?, lang = ?, raster = ?, role = ?, active = ? WHERE id = ?')
        for (const p of patch.printers) {
          const address = p.kind === 'virtual' ? '' : p.address.trim()
          if (existing.has(p.tempId)) {
            printerIds.set(p.tempId, p.tempId)
            update.run(p.name.trim(), p.kind, address, p.widthMm, p.lang, p.raster ? 1 : 0, p.role, p.active ? 1 : 0, p.tempId)
          } else {
            const id = newId()
            printerIds.set(p.tempId, id)
            insert.run(id, p.name.trim(), p.kind, address, p.widthMm, p.lang, p.raster ? 1 : 0, p.role, p.active ? 1 : 0)
          }
        }
        const keep = new Set(printerIds.values())
        for (const id of existing) if (!keep.has(id)) tx.db.prepare('DELETE FROM printers WHERE id = ?').run(id)
      } else {
        printerIds = new Map(known.size > 0 ? [...known].map((id) => [id, id] as const) : [])
      }
      if (patch.routing) {
        applied.add('printers')
        const categories = new Set(tx.db.prepare('SELECT id FROM categories').pluck().all() as string[])
        tx.db.exec('DELETE FROM category_printers')
        const insert = tx.db.prepare('INSERT OR IGNORE INTO category_printers (category_id, printer_id) VALUES (?, ?)')
        for (const [category, ids] of Object.entries(patch.routing)) {
          if (!categories.has(category)) continue
          for (const id of ids) {
            const printerId = printerIds.get(id)
            if (printerId) insert.run(category, printerId)
          }
        }
      }

      if (patch.backups) {
        applied.add('backups')
        const rows = tx.db.prepare('SELECT id, role, path FROM backup_destinations').all() as { id: string; role: string; path: string }[]
        const kept = new Set<string>()
        for (const b of backups) {
          const row = rows.find((r) => r.role === b.role && r.path === b.path)
          if (row) {
            kept.add(row.id)
            tx.db.prepare('UPDATE backup_destinations SET label = ?, enabled = 1 WHERE id = ?').run(b.label.trim(), row.id)
          } else {
            const id = newId()
            kept.add(id)
            tx.db
              .prepare('INSERT INTO backup_destinations (id, role, path, label, target_key, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
              .run(id, b.role, b.path, b.label.trim(), b.targetKey, tx.clock.now().toISOString())
          }
        }
        for (const row of rows) if (!kept.has(row.id)) tx.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(row.id)
      }
    })
    return { applied: [...applied] }
  })
}

export function exportCurrentProfile(deps: TechDeps): { bytes: Uint8Array; fileName: string } {
  const buffer = exportProfile(deps.db, { clock: deps.clock, appVersion: deps.appVersion })
  const day = deps.clock.now().toISOString().slice(0, 10)
  // A copy: a view on the Buffer's pool would carry the whole pool across IPC.
  return { bytes: new Uint8Array(buffer), fileName: `atlas-${day}.atlasprofile` }
}

/**
 * A profile applied to a running installation: `pre-change` backup, then its settings (not the legal identity
 * nor the business type, which belong to this business), modules and payment methods, and the catalogue merged
 * (the profile's products added, matched by name) or, with `replaceCatalog`, replaced together with the floor
 * plan (refused with `existing_data` once an order exists).
 */
export function importProfile(deps: TechDeps, buf: Buffer, options: { replaceCatalog: boolean }): Promise<Result<TechProfileImportDto>> {
  return attempt(async () => {
    const read = readProfile(buf)
    if (!read.ok) throw new AppErrorException(read.error.code, read.error.params)
    const profile = read.value
    if (options.replaceCatalog && ordersExist(deps.db)) throw new AppErrorException('existing_data')

    await preChangeBackup(deps)

    const repo = createCatalogRepo(deps.db)
    return deps.uow.run((tx) => {
      let settings = 0
      for (const [key, value] of Object.entries(profile.settings)) {
        if (!isSettingKey(key) || !isPortableSettingKey(key) || key === 'business.legal' || key === 'business.type') continue
        deps.settings.set(tx, key, value as never)
        settings++
      }
      deps.settings.set(tx, 'modules', profile.modules)
      const paymentMethods = seedPaymentMethods(tx, profile.paymentMethods)

      if (options.replaceCatalog) {
        wipeCatalogAndFloor(tx)
        seedCatalog(tx, repo, profile.catalog)
        seedFloor(tx, profile.rooms, profile.tables)
        return { settings, paymentMethods, catalog: 'replaced' as const, productsCreated: profile.catalog.products.length }
      }
      const categoryName = new Map(profile.catalog.categories.map((c) => [c.code, c.name.fr]))
      const rows: ImportRow[] = profile.catalog.products
        .filter((p) => p.active)
        .map((p, i) => ({
          row: i + 1,
          category: categoryName.get(p.category)!,
          nameFr: p.name.fr,
          ...(p.name.ar ? { nameAr: p.name.ar } : {}),
          ...(p.name.en ? { nameEn: p.name.en } : {}),
          priceCents: p.price_cents,
          vatBp: p.vat_bp,
          ...(p.barcode ? { barcode: p.barcode } : {}),
          soldByWeight: p.sold_by_weight,
          ...(p.stock_tracked ? { stockMilli: p.stock_milli } : {}),
          ...(p.color ? { color: p.color } : {})
        }))
      const created = rows.length === 0 ? 0 : mergeRows(tx, repo, rows)
      return { settings, paymentMethods, catalog: 'merged' as const, productsCreated: created }
    })
  })
}

const mergeRows = (tx: Tx, repo: CatalogRepo, rows: ImportRow[]): number => applyImport(tx, repo, rows, 'merge').summary.created

/** `time`, `level` and `event` of a pino line, the rest as `data`. */
const LEVELS: Record<number, LogLineDto['level']> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' }
const TAIL_BYTES = 1024 * 1024

/** The last `tail` lines of `logs/app.log`, oldest first. Lines that are not JSON are skipped. */
export function readLogs(paths: Pick<DataPaths, 'logs'>, tail: number): LogLineDto[] {
  let text = ''
  try {
    const fd = openSync(join(paths.logs, 'app.log'), 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      text = buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines: LogLineDto[] = []
  for (const line of text.split('\n').slice(-tail - 1)) {
    try {
      const { level, time, pid: _pid, event, msg, ...data } = JSON.parse(line) as Record<string, unknown>
      lines.push({
        time: typeof time === 'number' ? new Date(time).toISOString() : String(time ?? ''),
        level: LEVELS[Number(level)] ?? 'info',
        event: typeof event === 'string' ? event : typeof msg === 'string' ? msg : '',
        data
      })
    } catch {
      // a line cut by the tail window, or not JSON
    }
  }
  return lines.slice(-tail)
}

