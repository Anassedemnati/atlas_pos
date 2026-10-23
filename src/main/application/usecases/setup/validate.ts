import { existsSync } from 'node:fs'
import { MODULES } from '@shared/modules'
import { WIZARD_LAST_STEP, type PrinterDraft, type WizardDraft } from '@shared/setup/draft'
import { SETTINGS } from '../../../domain/config/settings-registry'
import { isValidPin, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, normalizeUsername } from '../../../domain/users/credentials'
import { isManagerPermissions } from '../../../domain/users/profile'
import { parseHostPort } from '../../../infrastructure/printing/drivers/network'
import { parseSerialAddress } from '../../../infrastructure/printing/drivers/serial'
import { AppErrorException } from '../../errors'
import { invalidInput } from '../users/outcome'
import type { DraftStore } from './draft-store'
import { sectionsFor, type SetupSource } from './sections'

/** The technician code is a secret like a password, a little shorter because it is typed rarely and read aloud. */
export const MIN_TECHNICIAN_CODE_LENGTH = 6

const fail = (field: string, reason: string): never => {
  throw invalidInput(field, reason)
}

interface Ctx {
  draft: WizardDraft
  source: SetupSource
  store: DraftStore
}

function checkType({ draft, source, store }: Ctx): void {
  for (const key of MODULES) if (typeof draft.modules[key] !== 'boolean') fail(`modules.${key}`, 'missing')
  if (draft.catalogSource === 'profile' && !source.profile) fail('catalogSource', 'no profile loaded')
  if (draft.catalogSource === 'import') {
    if (!draft.importFile || !store.isOwnFile(draft.importFile) || !existsSync(draft.importFile)) fail('importFile', 'preview the file first')
  }
}

function checkCompany({ draft, source }: Ctx): void {
  // Before the fields: a profile's identity is somebody else's until a person has seen it.
  if (draft.legalFromProfile) throw new AppErrorException('legal_not_confirmed', { field: 'legal' })
  const legal = SETTINGS['business.legal'].schema.safeParse(draft.legal)
  if (!legal.success) {
    const issue = legal.error.issues[0]
    fail(['legal', ...(issue?.path ?? [])].join('.'), issue?.message ?? 'invalid')
  }
  const rates = SETTINGS['vat.rates'].schema.safeParse(draft.vatRates)
  if (!rates.success) fail('vatRates', rates.error.issues[0]?.message ?? 'invalid')
  const allowed = new Set(draft.vatRates)
  const sections = sectionsFor(draft, source)
  const unknown = sections.products.find((p) => !allowed.has(p.vat_bp))
  if (unknown) fail('vatRates', `the catalogue uses ${unknown.vat_bp / 100} %`)
}

/** The rules of a list of printers (the wizard's draft, the technician's changes); `field` is the name of the list in errors. */
export function checkPrinters(printers: PrinterDraft[], field = 'printers'): Set<string> {
  const ids = new Set<string>()
  printers.forEach((printer, i) => {
    if (ids.has(printer.tempId)) fail(`${field}.${i}.tempId`, 'duplicate')
    ids.add(printer.tempId)
    if (printer.name.trim() === '') fail(`${field}.${i}.name`, 'required')
    if (printer.kind === 'virtual') return
    if (printer.address.trim() === '') fail(`${field}.${i}.address`, 'required')
    try {
      if (printer.kind === 'network') parseHostPort(printer.address)
      if (printer.kind === 'serial') parseSerialAddress(printer.address)
    } catch {
      fail(`${field}.${i}.address`, 'invalid address')
    }
  })
  return ids
}

function checkHardware({ draft, source }: Ctx): void {
  const ids = checkPrinters(draft.printers)
  const codes = new Set(sectionsFor(draft, source).categories.map((c) => c.code))
  const checkCodes = draft.catalogSource === 'template' || draft.catalogSource === 'profile'
  for (const [category, printers] of Object.entries(draft.routing)) {
    if (checkCodes && !codes.has(category)) fail(`routing.${category}`, 'unknown category')
    for (const tempId of printers) if (!ids.has(tempId)) fail(`routing.${category}`, `unknown printer "${tempId}"`)
  }
}

function checkUsers({ draft, source }: Ctx): void {
  if (draft.users.length === 0) fail('users', 'at least one user')
  const profiles = new Map(sectionsFor(draft, source).profiles.map((p) => [p.code, p]))
  const pins = new Set<string>()
  const usernames = new Set<string>()
  let managers = 0
  draft.users.forEach((user, i) => {
    if (user.displayName.trim() === '') fail(`users.${i}.displayName`, 'required')
    const profile = profiles.get(user.profileCode)
    if (!profile) fail(`users.${i}.profileCode`, 'unknown profile')
    if (!isValidPin(user.pin)) fail(`users.${i}.pin`, '4 to 6 digits')
    if (pins.has(user.pin)) fail(`users.${i}.pin`, 'already used')
    pins.add(user.pin)
    const hasName = user.username !== undefined && user.username.trim() !== ''
    const hasPassword = user.password !== undefined && user.password !== ''
    if (hasName !== hasPassword) fail(hasName ? `users.${i}.password` : `users.${i}.username`, 'username and password go together')
    if (hasName) {
      const username = normalizeUsername(user.username!)
      if (username === null) fail(`users.${i}.username`, 'invalid username')
      if (usernames.has(username!)) fail(`users.${i}.username`, 'already used')
      usernames.add(username!)
      const password = user.password!
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) fail(`users.${i}.password`, `${MIN_PASSWORD_LENGTH} characters at least`)
    }
    if (profile && isManagerPermissions(profile.permissions) && hasName) managers++
  })
  if (managers === 0) fail('users', 'a manager with a username and password is needed')
  const code = draft.technicianCode
  if (code.length < MIN_TECHNICIAN_CODE_LENGTH || code.length > MAX_PASSWORD_LENGTH) fail('technicianCode', `${MIN_TECHNICIAN_CODE_LENGTH} characters at least`)
  if (pins.has(code)) fail('technicianCode', 'must differ from every PIN')
}

function checkBackups({ draft }: Ctx): void {
  const seen = new Set<string>()
  draft.backups.forEach((backup, i) => {
    if (backup.path.trim() === '') fail(`backups.${i}.path`, 'required')
    const key = `${backup.role}\u0000${backup.path.trim()}`
    if (seen.has(key)) fail(`backups.${i}.path`, 'listed twice')
    seen.add(key)
  })
  const port = SETTINGS['backoffice.port'].schema.safeParse(draft.backofficePort)
  if (!port.success) fail('backofficePort', port.error.issues[0]?.message ?? 'invalid')
}

type Check = (ctx: Ctx) => void

/** What each step must satisfy before "Suivant". The first two have no rule beyond the shape of the draft. */
const STEP_CHECKS: Record<number, Check[]> = {
  0: [],
  1: [],
  2: [checkType],
  3: [checkCompany],
  4: [checkHardware],
  5: [checkUsers],
  6: [checkBackups],
  7: [checkType, checkCompany, checkHardware, checkUsers, checkBackups]
}

/** Throws `invalid_input` (`params.field`) or `legal_not_confirmed` for the first rule `step` breaks. */
export function validateStep(step: number, draft: WizardDraft, source: SetupSource, store: DraftStore): void {
  if (!Number.isInteger(step) || step < 0 || step > WIZARD_LAST_STEP) throw invalidInput('validateStep', 'unknown step')
  for (const check of STEP_CHECKS[step] ?? []) check({ draft, source, store })
}

/** The whole draft: every step's rules. */
export const validateDraft = (draft: WizardDraft, source: SetupSource, store: DraftStore): void => validateStep(WIZARD_LAST_STEP, draft, source, store)
