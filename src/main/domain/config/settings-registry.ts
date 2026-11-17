import { z } from 'zod'
import { MODULES, type ModuleKey } from '@shared/modules'
import type { Lang } from '@shared/names'
import type { Permission } from '@shared/permissions'

export const BUSINESS_TYPES = ['restaurant', 'cafe', 'bakery', 'retail'] as const
export type BusinessType = (typeof BUSINESS_TYPES)[number]

export type SettingScope = 'installation' | 'user'
/** Who may change a setting: the holder of a permission, or only the technician (with the technician code). */
export type SettingPermission = Permission | 'technician'

interface SettingDef<S extends z.ZodType> {
  schema: S
  default: z.output<S>
  scope: SettingScope
  permission: SettingPermission
}

/** Keeps each entry's own schema type, so `SettingValue<K>` is exact per key. */
const define = <S extends z.ZodType>(def: SettingDef<S>): SettingDef<S> => def

const text = z.string().trim().min(1)
const langs = ['fr', 'ar', 'en'] as const satisfies readonly Lang[]
const reasons = z.array(text)

/** May be left empty; filled in, it must be something (not only spaces). */
const optionalText = z.string().trim()

/** All 15 digits, as printed on the ICE certificate (spaces around it are tolerated), or empty: not every business has one. */
const ice = z.string().trim().regex(/^(\d{15})?$/)

const noModules = Object.fromEntries(MODULES.map((m) => [m, false])) as Record<ModuleKey, boolean>

/**
 * Every setting, declared once: its value schema, default, scope and who may change it. The wizard,
 * the technician menu and the back office render their forms from this object. Labels are
 * i18n keys derived from the setting key (`settings.<key>`), so they are not repeated here.
 */
export const SETTINGS = {
  'business.legal': define({
    schema: z.strictObject({
      // Only the trade name is required: many cafés and shops are run by a person with a patente and
      // no company (no raison sociale, ICE, IF or RC). An empty field is simply not printed.
      raisonSociale: optionalText,
      nomCommercial: text,
      adresse: optionalText,
      ville: optionalText,
      telephone: optionalText,
      ice,
      if: optionalText,
      rc: optionalText,
      patente: optionalText
    }),
    // A blank form, not a valid value: the business has no sensible default name, and `set` rejects
    // this object until the trade name is filled.
    default: {
      raisonSociale: '',
      nomCommercial: '',
      adresse: '',
      ville: '',
      telephone: '',
      ice: '',
      if: '',
      rc: '',
      patente: ''
    },
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'business.type': define({
    schema: z.enum(BUSINESS_TYPES),
    default: 'restaurant' as BusinessType,
    scope: 'installation',
    permission: 'technician'
  }),
  'business.logo': define({
    schema: z.string().trim().min(1).nullable(),
    default: null as string | null,
    scope: 'installation',
    permission: 'settings.manage'
  }),
  modules: define({
    schema: z.record(z.enum(MODULES), z.boolean()),
    default: noModules,
    scope: 'installation',
    permission: 'technician'
  }),
  'vat.rates': define({
    schema: z.array(z.number().int().min(0).max(10000)).min(1),
    default: [2000, 1400, 1000, 700, 0],
    scope: 'installation',
    permission: 'technician'
  }),
  'receipt.lang': define({
    schema: z.enum(langs),
    default: 'fr' as Lang,
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'receipt.header': define({ schema: z.string(), default: '', scope: 'installation', permission: 'settings.manage' }),
  'receipt.footer': define({
    schema: z.string(),
    default: 'Merci de votre visite !',
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'ui.defaultLang': define({
    schema: z.enum(langs),
    default: 'fr' as Lang,
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'ui.ticketSide': define({
    schema: z.enum(['start', 'end']),
    default: 'start' as 'start' | 'end',
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'ui.keyStyle': define({
    schema: z.enum(['color', 'photo']),
    default: 'color' as 'color' | 'photo',
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'till.autoLockSeconds': define({
    schema: z.number().int().positive().max(3600),
    default: 120,
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'day.cutoverHour': define({
    schema: z.number().int().min(0).max(23),
    default: 5,
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'kiosk.enabled': define({ schema: z.boolean(), default: true, scope: 'installation', permission: 'technician' }),
  'autostart.enabled': define({ schema: z.boolean(), default: true, scope: 'installation', permission: 'technician' }),
  'display.customerEnabled': define({
    schema: z.boolean(),
    default: false,
    scope: 'installation',
    permission: 'technician'
  }),
  'backoffice.enabled': define({ schema: z.boolean(), default: true, scope: 'installation', permission: 'technician' }),
  'backoffice.port': define({
    schema: z.number().int().min(1024).max(65535),
    default: 8080,
    scope: 'installation',
    permission: 'technician'
  }),
  'backup.continuous': define({ schema: z.boolean(), default: true, scope: 'installation', permission: 'technician' }),
  'backup.onClose': define({ schema: z.boolean(), default: true, scope: 'installation', permission: 'technician' }),
  'backup.retentionDays': define({
    schema: z.number().int().positive(),
    default: 30,
    scope: 'installation',
    permission: 'technician'
  }),
  'backup.warnAfterHours': define({
    schema: z.number().int().positive(),
    default: 24,
    scope: 'installation',
    permission: 'technician'
  }),
  'discount.reasons': define({
    schema: reasons,
    default: ['Client fidèle', 'Geste commercial', 'Erreur de commande'],
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'cancel.reasons': define({
    schema: reasons,
    default: ['Erreur de saisie', 'Client parti', 'Produit indisponible'],
    scope: 'installation',
    permission: 'settings.manage'
  }),
  'tech.codeHash': define({
    schema: z.string().min(1).nullable(),
    default: null as string | null,
    scope: 'installation',
    permission: 'technician'
  })
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>
export type SettingsValues = { [K in SettingKey]: SettingValue<K> }

export const SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[]

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key)

/** A fresh copy of the default, so a caller can never mutate the registry through it. */
export function defaultOf<K extends SettingKey>(key: K): SettingValue<K> {
  return structuredClone(SETTINGS[key].default) as SettingValue<K>
}

// Portable settings: the ones templates and setup profiles may carry.
// - tech.codeHash is a secret.
// - business.logo is a path to a file on this machine (the profile carries no files).
// - modules travel as their own section.
const NOT_PORTABLE = ['tech.codeHash', 'business.logo', 'modules'] as const satisfies readonly SettingKey[]

export type PortableSettingKey = Exclude<SettingKey, (typeof NOT_PORTABLE)[number]>
export type PortableSettings = { [K in PortableSettingKey]?: SettingValue<K> }

export const isPortableSettingKey = (key: string): key is PortableSettingKey =>
  isSettingKey(key) && !(NOT_PORTABLE as readonly string[]).includes(key)

export const PORTABLE_SETTING_KEYS: readonly PortableSettingKey[] = SETTING_KEYS.filter(isPortableSettingKey)

/** Any subset of the portable settings, each validated by its own schema; unknown keys are an error. */
export const portableSettingsSchema = z.strictObject(
  Object.fromEntries(PORTABLE_SETTING_KEYS.map((key) => [key, SETTINGS[key].schema.optional()]))
) as unknown as z.ZodType<PortableSettings>
