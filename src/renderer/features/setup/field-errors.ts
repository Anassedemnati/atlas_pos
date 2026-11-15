import i18n from '../../app/i18n'
import { fieldKind, type FieldIssue } from './steps-config'

/** The server's short reasons (English, for logs) and the text key each one maps to. */
const REASONS: Record<string, string> = {
  required: 'required',
  'already used': 'used',
  duplicate: 'used',
  'listed twice': 'twice',
  'must differ from every PIN': 'techPin',
  'username and password go together': 'together',
  '4 to 6 digits': 'pin',
  'invalid address': 'address',
  not_confirmed: 'notConfirmed'
}

/**
 * The sentence for a field the main process refused. The most specific text wins:
 * `<field>_<reason>`, `<field>`, the field's first segment, the reason, then a generic one.
 */
export function fieldMessage(issue: FieldIssue): string {
  const kind = fieldKind(issue.field).replace(/\./g, '_')
  const root = issue.field.split('.')[0] ?? kind
  const reason = issue.reason ? REASONS[issue.reason] : undefined
  const prefix = 'setupWizard.fieldErrors.'
  const keys = [
    ...(reason ? [`${prefix}${kind}_${reason}`] : []),
    `${prefix}${kind}`,
    `${prefix}${root}`,
    ...(reason ? [`${prefix}reason_${reason}`] : []),
    `${prefix}generic`
  ]
  return i18n.t(keys)
}
