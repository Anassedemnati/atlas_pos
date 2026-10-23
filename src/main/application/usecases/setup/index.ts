import { rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { BackupEntryDto, BackupTargetTestDto, ParsedCatalogSheet, SetupDraftStateDto, SetupTemplateDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { WizardDraftSchema, type PrinterDraft, type WizardPatch } from '@shared/setup/draft'
import { pickedFolderTarget, toBackupEntryDto } from '../../../infrastructure/backup/picked'
import { listBackups } from '../../../infrastructure/backup/restore'
import { readInstallation, writeInstallation } from '../../../infrastructure/fs/installation'
import { parseCatalogSheet } from '../../../infrastructure/import/catalog-sheet'
import type { HtmlPrinter, RenderHtmlToBitmap } from '../../../infrastructure/printing/types'
import { readProfile } from '../../../infrastructure/profile/profile-io'
import type { Logger } from '../../../logger'
import type { DataPaths } from '../../../paths'
import type { Clock, EventBus } from '../../ports'
import { attempt, attemptSync, invalidInput, refuse } from '../users/outcome'
import { createDraftStore, type DraftStore } from './draft-store'
import { runFinish, type FinishValue } from './finish'
import { testDraftPrinter } from './printer-test'
import { applyProfileToDraft } from './profile-draft'
import { sourceOf } from './sections'
import { testBackupTarget, type TargetTestInput } from './targets'
import { describeProfile, listTemplates } from './templates'
import { validateStep } from './validate'

export interface SetupDeps {
  paths: DataPaths
  clock: Clock
  bus: EventBus
  log: Logger
  appVersion: string
  /** HTML to bitmap (Electron's offscreen window), for the test page of a raster or Arabic printer. */
  rasterize: RenderHtmlToBitmap
  htmlPrinter?: HtmlPrinter
  /** Registers (or not) the start with the OS. */
  setAutostart(enabled: boolean): void
  /** Replaces the database with a backup and opens the services (`Runtime.restore`). */
  restore(file: string): Promise<Result<{ route: string }>>
  /** Replaceable by tests, to make the end of the setup fail. */
  writeInstallation?: typeof writeInstallation
}

const LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])
const MAX_LOGO_BYTES = 2 * 1024 * 1024

/**
 * The first-run wizard's back end: the resumable draft, the templates, the hardware and backup tests,
 * the Excel/CSV preview, the profile import, and the end of the setup (`finishSetup`). It works while no
 * database exists; the IPC layer only calls it then. Every method returns a `Result`; none throws.
 */
export interface SetupService {
  templates(): SetupTemplateDto[]
  getDraft(): SetupDraftStateDto
  /** Merges the patch and saves the draft atomically; with `validateStep`, only when that step's rules hold. */
  saveDraft(patch: WizardPatch, validateAt?: number): Result<SetupDraftStateDto>
  resetDraft(): SetupDraftStateDto
  testPrinter(printer: PrinterDraft, action?: 'page' | 'drawer'): Promise<Result<null>>
  testBackupTarget(input: TargetTestInput): Promise<Result<BackupTargetTestDto>>
  previewImport(buf: Uint8Array, fileName: string): ParsedCatalogSheet
  pickLogo(buf: Uint8Array, fileName: string): Result<SetupDraftStateDto>
  applyProfileToDraft(buf: Buffer): Result<SetupDraftStateDto>
  /** See `runFinish`. The services are not opened here: that is the runtime's (`Runtime.reopen`). */
  finishSetup(): Promise<Result<FinishValue>>
  listBackupsAt(folder: string): Promise<BackupEntryDto[]>
  /**
   * Restore mode: the backup must be one of `listBackupsAt(folder)`. `installation.json` is written first
   * (a restored database says nothing of it), from the backup's manifest; if the restore fails it is
   * removed again. The draft is forgotten once the restore worked.
   */
  restoreFrom(file: string, folder: string): Promise<Result<{ route: string }>>
}

export function createSetupService(deps: SetupDeps, store: DraftStore = createDraftStore(deps.paths)): SetupService {
  const { paths, clock, log } = deps
  let finishing = false
  let templates: SetupTemplateDto[] | null = null

  const state = (): SetupDraftStateDto => {
    const profile = store.loadedProfile()
    return { draft: store.read(), profile: profile ? describeProfile(profile) : null }
  }

  return {
    templates: () => (templates ??= listTemplates()),
    getDraft: state,

    saveDraft: (patch, validateAt) =>
      attemptSync(() => {
        // What the renderer may not decide: the confirmation of a profile's identity (saving `legal` is it) and the
        // files, which are only ever our own copies (`setup.previewImport`, `setup.pickLogo`).
        const { legalFromProfile: _ignored, ...own } = patch
        for (const key of ['importFile', 'logoPath'] as const) {
          const path = own[key]
          if (path !== undefined && !store.isOwnFile(path)) throw invalidInput(key, 'set by setup.previewImport / setup.pickLogo')
        }
        const checked = WizardDraftSchema.safeParse({ ...store.read(), ...own, ...(own.legal ? { legalFromProfile: false } : {}) })
        if (!checked.success) {
          const issue = checked.error.issues[0]
          throw invalidInput((issue?.path ?? []).join('.'), issue?.message)
        }
        const merged = checked.data
        if (validateAt !== undefined) validateStep(validateAt, merged, sourceOf(merged, store.loadedProfile()), store)
        store.write(merged)
        return state()
      }),

    resetDraft() {
      store.clear()
      return state()
    },

    testPrinter: (printer, action = 'page') =>
      testDraftPrinter(
        { printsDir: paths.prints, clock, rasterize: deps.rasterize, ...(deps.htmlPrinter ? { htmlPrinter: deps.htmlPrinter } : {}) },
        printer,
        { businessName: store.read().legal.nomCommercial.trim() || 'Atlas POS', action }
      ),

    testBackupTarget,

    previewImport(buf, fileName) {
      const draft = store.read()
      const parsed = parseCatalogSheet(buf, fileName, draft.vatRates)
      const ext = extname(fileName).toLowerCase()
      const usable = parsed.errors.length === 0 && parsed.rows.length > 0 && (ext === '.xlsx' || ext === '.csv')
      // The draft points at a copy we keep, only for a sheet that can be applied.
      const importFile = usable ? store.stash('import', ext.slice(1), buf) : undefined
      const { importFile: _old, ...rest } = draft
      store.write({ ...rest, ...(importFile ? { importFile } : {}) })
      return parsed
    },

    pickLogo: (buf, fileName) =>
      attemptSync(() => {
        const ext = extname(fileName).toLowerCase()
        if (!LOGO_EXTENSIONS.has(ext)) throw invalidInput('logo', 'png, jpg, webp or svg')
        if (buf.byteLength > MAX_LOGO_BYTES) throw invalidInput('logo', 'too large (2 MB at most)')
        store.write({ ...store.read(), logoPath: store.stash('logo', ext.slice(1), buf) })
        return state()
      }),

    applyProfileToDraft: (buf) => {
      const read = readProfile(buf)
      if (!read.ok) return read
      store.saveProfile(read.value)
      store.write(applyProfileToDraft(store.read(), read.value))
      return { ok: true, value: state() }
    },

    async finishSetup() {
      if (finishing) return refuse('setup_in_progress')
      finishing = true
      try {
        return await attempt(() => runFinish({ ...deps, store }))
      } finally {
        finishing = false
      }
    },

    async listBackupsAt(folder) {
      return (await listBackups([pickedFolderTarget(folder)], folder)).map((entry) => toBackupEntryDto(entry, true))
    },

    async restoreFrom(file, folder) {
      const entry = (await listBackups([pickedFolderTarget(folder)], folder)).find((e) => e.file === file)
      if (!entry) return refuse('backup_not_found')
      const write = deps.writeInstallation ?? writeInstallation
      const now = clock.now().toISOString()
      write(paths, { installationId: entry.manifest.installationId || newId(), createdAt: now, setupCompletedAt: now, appVersion: deps.appVersion })
      const result = await deps.restore(file)
      if (!result.ok) {
        // Not restored: this is still a new installation.
        if (readInstallation(paths)) rmSync(join(paths.config, 'installation.json'), { force: true })
        return result
      }
      try {
        store.clear()
      } catch (error) {
        log.warn('setup.draft_not_deleted', { message: String(error) })
      }
      return result
    }
  }
}
