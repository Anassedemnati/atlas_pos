import type { WizardDraft, WizardPatch } from '@shared/setup/draft'

/** The wizard's screens: the draft's `step` (0 Start, 1-6 the numbered steps, 7 the summary). */
export const STEP_START = 0
export const STEP_LANGUAGE = 1
export const STEP_BUSINESS = 2
export const STEP_COMPANY = 3
export const STEP_HARDWARE = 4
export const STEP_USERS = 5
export const STEP_BACKUPS = 6
export const STEP_FINISH = 7
/** The numbered steps ("Étape N sur 6"). */
export const NUMBERED_STEPS = 6

/** Translation keys of the six numbered steps, in order (`setupWizard.steps.<key>`). */
export const STEP_KEYS = ['language', 'business', 'company', 'hardware', 'users', 'backups'] as const

/**
 * What each step owns in the draft. "Suivant" sends these fields only: a patch never carries the fields the
 * main process owns (`importFile`, `logoPath`, `legalFromProfile`), and `legal` goes only with the Entreprise
 * step, because saving it is what confirms a profile's identity.
 */
export const STEP_FIELDS: Record<number, readonly (keyof WizardDraft)[]> = {
  [STEP_LANGUAGE]: ['lang'],
  [STEP_BUSINESS]: ['businessType', 'modules', 'catalogSource'],
  [STEP_COMPANY]: ['legal', 'vatRates', 'receiptHeader', 'receiptFooter'],
  [STEP_HARDWARE]: ['printers', 'routing', 'customerDisplay'],
  [STEP_USERS]: ['users', 'technicianCode'],
  [STEP_BACKUPS]: ['backups', 'backupSchedule', 'autostart', 'kiosk', 'backofficePort']
}

/** The patch "Suivant" sends when leaving `step`: that step's fields, whole, and the next step number. */
export function nextPatch(draft: WizardDraft, step: number): WizardPatch {
  const fields = STEP_FIELDS[step] ?? []
  const patch: Record<string, unknown> = {}
  for (const field of fields) patch[field] = draft[field]
  patch['step'] = step + 1
  return patch as WizardPatch
}

/** `users.1.pin` -> `users.pin`: the kind of field, whatever its row. */
export const fieldKind = (field: string): string => field.replace(/\.\d+(?=\.|$)/g, '')

/** The step that shows a field (to send the person back to it), or null when unknown. */
export function stepOfField(field: string): number | null {
  const root = field.split('.')[0] ?? ''
  for (const [step, fields] of Object.entries(STEP_FIELDS)) if ((fields as readonly string[]).includes(root)) return Number(step)
  if (root === 'importFile') return STEP_BUSINESS
  if (root === 'modules') return STEP_BUSINESS
  return null
}

/** A failed save, as the screen shows it: which field, and the server's short reason (English, for the log). */
export interface FieldIssue {
  field: string
  reason?: string
}

export function issueOf(error: { code: string; params?: Record<string, unknown> }): FieldIssue | null {
  if (error.code === 'legal_not_confirmed') return { field: 'legal', reason: 'not_confirmed' }
  if (error.code !== 'invalid_input') return null
  const field = error.params?.['field']
  if (typeof field !== 'string') return null
  const reason = error.params?.['reason']
  return typeof reason === 'string' ? { field, reason } : { field }
}

const isPin = (value: string): boolean => /^\d{4,6}$/.test(value)

/**
 * The rules of the two form-heavy steps, checked here as well so that every missing field shows at once (the main
 * process stops at the first one). It stays the authority: it checks these again, and the rest, when saving.
 */
export function localIssues(step: number, draft: WizardDraft): FieldIssue[] {
  const issues: FieldIssue[] = []
  if (step === STEP_COMPANY) {
    for (const [key, value] of Object.entries(draft.legal)) {
      if (key === 'ice') {
        if (!/^\d{15}$/.test(value.trim())) issues.push({ field: 'legal.ice' })
      } else if (value.trim() === '') issues.push({ field: `legal.${key}`, reason: 'required' })
    }
  }
  if (step === STEP_USERS) {
    const pins = new Map<string, number>()
    draft.users.forEach((user, index) => {
      if (user.displayName.trim() === '') issues.push({ field: `users.${index}.displayName`, reason: 'required' })
      if (!isPin(user.pin)) issues.push({ field: `users.${index}.pin`, reason: '4 to 6 digits' })
      else if (pins.has(user.pin)) issues.push({ field: `users.${index}.pin`, reason: 'already used' })
      else pins.set(user.pin, index)
      if (index === 0) {
        if ((user.username ?? '').trim() === '') issues.push({ field: 'users.0.username', reason: 'required' })
        if ((user.password ?? '').length < 8) issues.push({ field: 'users.0.password' })
      }
    })
    if (draft.technicianCode.length < 6) issues.push({ field: 'technicianCode' })
    else if (pins.has(draft.technicianCode)) issues.push({ field: 'technicianCode', reason: 'must differ from every PIN' })
  }
  return issues
}
