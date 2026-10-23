import { z } from 'zod'
import { MODULES } from '../modules'

// The wizard's saved state (`config/wizard-draft.json`). These are the SHAPE rules only: a draft is
// saved while the person is still typing, so a blank ICE or a short PIN is a valid draft. The
// business rules (ICE, PIN, passwords...) are checked per step and at `setup.finish` in the main process.

/** The wizard's steps: 0 Start, 1 Langue, 2 Type d'activité, 3 Entreprise, 4 Matériel, 5 Utilisateurs, 6 Sauvegardes, 7 Résumé. */
export const WIZARD_LAST_STEP = 7

export const BUSINESS_TYPE_IDS = ['restaurant', 'cafe', 'bakery', 'retail'] as const
export const PRINTER_KINDS = ['network', 'serial', 'device-file', 'windows-raw', 'os-html', 'virtual'] as const
export const PRINTER_ROLES = ['receipt', 'kitchen', 'bar'] as const
export const BACKUP_ROLES = ['disk', 'usb', 'nas'] as const

const lang = z.enum(['fr', 'ar', 'en'])

export const PrinterDraftSchema = z.strictObject({
  /** The wizard's own id for the printer (a printer has no database id yet); `routing` refers to it. */
  tempId: z.string().min(1).max(64),
  name: z.string().max(100),
  kind: z.enum(PRINTER_KINDS),
  /** `host[:port]` (network), `path[@baud]` (serial), device file, Windows or system printer name. Unused by `virtual`. */
  address: z.string().max(500),
  widthMm: z.union([z.literal(58), z.literal(80)]),
  /** Language of kitchen tickets and test pages printed here. */
  lang,
  raster: z.boolean(),
  role: z.enum(PRINTER_ROLES),
  active: z.boolean()
})

export const UserDraftSchema = z.strictObject({
  displayName: z.string().max(60),
  /** 4 to 6 digits, different for every user. */
  pin: z.string().max(16),
  /** The `code` of one of the profiles (template or imported profile): `gerant`, `caissier`, `serveur`... */
  profileCode: z.string().max(64),
  /** Back office access: both or none. The password has 8 characters at least. */
  username: z.string().max(200).optional(),
  password: z.string().max(1000).optional()
})

export const BackupDraftSchema = z.strictObject({
  role: z.enum(BACKUP_ROLES),
  path: z.string().max(4096),
  label: z.string().max(100),
  /**
   * The content of the destination's `AtlasBackup/.atlas-target` marker. Created by `setup.testBackupTarget`
   * (keep the value it returns here); a destination saved without one gets a key when the setup finishes.
   */
  targetKey: z.string().max(100).optional()
})

export const LegalDraftSchema = z.strictObject({
  raisonSociale: z.string().max(200),
  nomCommercial: z.string().max(200),
  adresse: z.string().max(500),
  ville: z.string().max(100),
  telephone: z.string().max(50),
  ice: z.string().max(50),
  if: z.string().max(50),
  rc: z.string().max(50),
  patente: z.string().max(50)
})

export const WizardDraftSchema = z.strictObject({
  step: z.number().int().min(0).max(WIZARD_LAST_STEP),
  startMode: z.enum(['new', 'profile', 'restore']),
  lang: z.strictObject({ setup: lang, receipt: lang, staffDefault: lang }),
  businessType: z.enum(BUSINESS_TYPE_IDS),
  modules: z.record(z.enum(MODULES), z.boolean()),
  /** `profile`: the catalogue of the `.atlasprofile` loaded with `setup.applyProfile`. */
  catalogSource: z.enum(['template', 'import', 'empty', 'profile']),
  /** Set by `setup.previewImport` (a copy kept in the data directory); the renderer never sets it. */
  importFile: z.string().max(4096).optional(),
  legal: LegalDraftSchema,
  /**
   * True while `legal` was taken from a profile: the legal identity must be checked by a person, so the
   * setup does not finish until the Entreprise step is saved again (saving `legal` clears the flag).
   */
  legalFromProfile: z.boolean(),
  /** Set by `setup.pickLogo` (a copy kept in the data directory); the renderer never sets it. */
  logoPath: z.string().max(4096).optional(),
  vatRates: z.array(z.number().int().min(0).max(10000)).min(1).max(10),
  receiptHeader: z.string().max(1000),
  receiptFooter: z.string().max(1000),
  printers: z.array(PrinterDraftSchema).max(20),
  /** Category `code` (template or profile) -> the `tempId`s of the printers that print its lines. Empty: the template's defaults, by printer role. */
  routing: z.record(z.string(), z.array(z.string().max(64)).max(20)),
  customerDisplay: z.boolean(),
  users: z.array(UserDraftSchema).max(50),
  /** The technician's secret (6 characters at least), separate from every PIN and password. */
  technicianCode: z.string().max(256),
  backups: z.array(BackupDraftSchema).max(10),
  backupSchedule: z.strictObject({
    continuous: z.boolean(),
    onClose: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650)
  }),
  autostart: z.boolean(),
  kiosk: z.boolean(),
  backofficePort: z.number().int().min(1).max(65535)
})

export type WizardDraft = z.output<typeof WizardDraftSchema>
export type PrinterDraft = z.output<typeof PrinterDraftSchema>
export type UserDraft = z.output<typeof UserDraftSchema>
export type BackupDraft = z.output<typeof BackupDraftSchema>

/** Any subset of the draft: what `setup.saveDraft` takes (a nested object, such as `legal`, is replaced whole). */
export const WizardPatchSchema = WizardDraftSchema.partial()
export type WizardPatch = z.output<typeof WizardPatchSchema>

const NO_MODULES = Object.fromEntries(MODULES.map((m) => [m, false])) as Record<(typeof MODULES)[number], boolean>

/** A new wizard: French everywhere, restaurant, the template's catalogue, local backups, auto-start and kiosk on. */
export function defaultDraft(): WizardDraft {
  return {
    step: 0,
    startMode: 'new',
    lang: { setup: 'fr', receipt: 'fr', staffDefault: 'fr' },
    businessType: 'restaurant',
    modules: { ...NO_MODULES, tables: true, kitchen: true, menus: true, customers: true },
    catalogSource: 'template',
    legal: { raisonSociale: '', nomCommercial: '', adresse: '', ville: '', telephone: '', ice: '', if: '', rc: '', patente: '' },
    legalFromProfile: false,
    vatRates: [2000, 1400, 1000, 700, 0],
    receiptHeader: '',
    receiptFooter: 'Merci de votre visite !',
    printers: [],
    routing: {},
    customerDisplay: false,
    users: [],
    technicianCode: '',
    backups: [],
    backupSchedule: { continuous: true, onClose: true, retentionDays: 30 },
    autostart: true,
    kiosk: true,
    backofficePort: 8080
  }
}
