import { z } from 'zod'
import type {
  BackupEntryDto,
  BackupTargetTestDto,
  HardwareDto,
  LogLineDto,
  ParsedCatalogSheet,
  SetupDraftStateDto,
  SetupFinishDto,
  SetupTemplateDto,
  TechChangesDto,
  TechProfileImportDto
} from '../dto'
import { PrinterDraftSchema, WizardPatchSchema, WIZARD_LAST_STEP } from '../setup/draft'
import { bytes, def, none } from './define'

/**
 * A file the main process reads, from the system dialog (`system.pickFile` gives its `path`) or as bytes
 * (a drag and drop, a file input): exactly one of the two.
 */
const fileSource = {
  path: z.string().min(1).max(4096).optional(),
  bytes: bytes.optional(),
  fileName: z.string().min(1).max(260).optional()
}
const oneFile = (value: { path?: string | undefined; bytes?: Uint8Array | undefined }): boolean =>
  (value.path === undefined) !== (value.bytes === undefined)
const FILE_MESSAGE = { message: 'give a path or bytes, not both' }

/**
 * The first-run wizard's back end. Every `setup.*` channel works only while the application waits for its
 * setup (no installation yet, no database open); afterwards it answers `forbidden` (`params.reason`:
 * `setup_complete`). They need no sign-in: nobody can have one yet.
 */
export const setupChannels = {
  /** The four business templates (modules, counts, categories with their default printer role, profiles). */
  'setup.templates': def<SetupTemplateDto[]>()(none, 'handler'),
  /** The saved wizard state (the defaults for a new setup), and the profile loaded into it, if any. */
  'setup.getDraft': def<SetupDraftStateDto>()(none, 'handler'),
  /**
   * Merges `patch` into the draft and saves it atomically. Saving `legal` clears `legalFromProfile`: send `legal` only from the Entreprise step's own save (the confirmation of a profile's identity). With
   * `validateStep` (the step being left, before "Suivant"), the merged draft must pass that step's rules,
   * else `invalid_input` (`params.field`) and nothing is saved.
   */
  'setup.saveDraft': def<SetupDraftStateDto>()(
    z.strictObject({ patch: WizardPatchSchema, validateStep: z.number().int().min(0).max(WIZARD_LAST_STEP).optional() }),
    'handler'
  ),
  /** Forgets the draft, the loaded profile and the import and logo copies: a new wizard. */
  'setup.resetDraft': def<SetupDraftStateDto>()(none, 'handler'),
  'setup.detectHardware': def<HardwareDto>()(none, 'handler'),
  /**
   * Prints the test page (or, with `action: 'drawer'`, pulses the cash drawer) on a printer of the draft. A
   * `virtual` printer writes its files to `<data>/prints`. Errors: `print_failed`, `invalid_input`.
   */
  'setup.testPrinter': def<null>()(
    z.strictObject({ printer: PrinterDraftSchema, action: z.enum(['page', 'drawer']).optional() }),
    'handler'
  ),
  /**
   * Checks a backup destination end to end (write, read back, verify) and marks it (`AtlasBackup/.atlas-target`).
   * Pass the `targetKey` of an earlier test of the same destination. A marker that holds another key is
   * `marker_conflict` (`params.existingKey`) unless `overwrite` is true. Other errors: `backup_target_unavailable`,
   * `backup_probe_failed`.
   */
  'setup.testBackupTarget': def<BackupTargetTestDto>()(
    z.strictObject({
      role: z.enum(['disk', 'usb', 'nas']),
      path: z.string().min(1).max(4096),
      label: z.string().max(100).optional(),
      targetKey: z.string().min(1).max(100).optional(),
      overwrite: z.boolean().optional()
    }),
    'handler'
  ),
  /**
   * Reads an Excel (.xlsx) or CSV catalogue and shows what would be imported (`rows`, `errors`), checked against
   * the draft's VAT rates. Keeps a copy and sets `draft.importFile`; the setup applies it only when `errors` is
   * empty. Errors in `errors[]`, not as a failure; a file that cannot be read at all is `invalid_input`.
   */
  'setup.previewImport': def<ParsedCatalogSheet>()(
    z.strictObject(fileSource).refine(oneFile, FILE_MESSAGE),
    'handler'
  ),
  /** Keeps a copy of a logo image (png, jpg, webp or svg, 2 MB at most) and sets `draft.logoPath`. */
  'setup.pickLogo': def<SetupDraftStateDto>()(z.strictObject(fileSource).refine(oneFile, FILE_MESSAGE), 'handler'),
  /**
   * Loads a `.atlasprofile` into the draft (settings, modules, printers, catalogue source `profile`) and sets
   * `legalFromProfile`: save the Entreprise step again before finishing. Errors: `invalid_profile`, `profile_newer_version`.
   */
  'setup.applyProfile': def<SetupDraftStateDto>()(z.strictObject(fileSource).refine(oneFile, FILE_MESSAGE), 'handler'),
  /**
   * Creates the database and seeds it, writes the installation, runs the first full backup, registers the
   * auto-start, deletes the draft, and opens the services: the till can go to `#/login` (`setup.openTill`) at
   * once. Safe to call again after a failure. Errors: `invalid_input` (`params.field`), `legal_not_confirmed`,
   * `existing_data`, `setup_in_progress`, `setup_failed` (`params.stage`).
   */
  'setup.finish': def<SetupFinishDto>()(none, 'handler'),
  /** Loads the till window on its start route (`#/login`) as a new document. Works once the setup has finished, while nobody is signed in on the window (else `forbidden`). */
  'setup.openTill': def<true>()(none, 'handler'),
  /** Restore mode: the backups in a folder chosen with `system.pickFolder`. */
  'setup.listBackupsAt': def<BackupEntryDto[]>()(z.strictObject({ folder: z.string().min(1).max(4096) }), 'handler'),
  /** Restore mode: restores a backup listed by `setup.listBackupsAt` (same `folder`) onto this new installation. */
  'setup.restoreFrom': def<{ route: string }>()(
    z.strictObject({ file: z.string().min(1).max(4096), folder: z.string().min(1).max(4096) }),
    'handler'
  )
}

/** The technician menu: every channel needs the technician mode of the window (`users.verifyTechnician`). */
export const techChannels = {
  /**
   * Takes a `pre-change` backup, then applies the parts of the draft it knows (legal, vat, receipt texts, languages,
   * modules, customer display, kiosk, autostart, back office port, backup schedule, printers, routing, backups,
   * technician code). Printers are matched by `tempId` = the printer's database id (a new tempId adds one; a
   * printer left out is removed); routing keys are category ids here. Not applied: users, catalogue.
   */
  'tech.applyChanges': def<TechChangesDto>()(z.strictObject({ patch: WizardPatchSchema }), 'technician'),
  /** The current setup as a `.atlasprofile`. */
  'tech.exportProfile': def<{ bytes: Uint8Array; fileName: string }>()(none, 'technician'),
  /**
   * Takes a `pre-change` backup, then applies a profile's settings, modules and payment methods. The catalogue is
   * merged (products added), or with `replaceCatalog` replaced along with rooms and tables, which is refused
   * (`existing_data`) once an order exists.
   */
  'tech.importProfile': def<TechProfileImportDto>()(
    z.strictObject({ ...fileSource, replaceCatalog: z.boolean() }).refine(oneFile, FILE_MESSAGE),
    'technician'
  ),
  /** The last log lines (200 by default, 1000 at most), oldest first. */
  'tech.logs': def<LogLineDto[]>()(z.strictObject({ tail: z.number().int().min(1).max(1000).optional() }), 'technician'),
  /** Same as `backup.restore`. */
  'tech.restore': def<{ route: string }>()(
    z.strictObject({ file: z.string().min(1).max(4096), folder: z.string().max(4096).optional() }),
    'technician'
  ),
  /** Same as `app.quitToDesktop`. */
  'tech.quitToDesktop': def<true>()(none, 'technician')
}
