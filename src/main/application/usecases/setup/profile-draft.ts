import { PRINTER_KINDS, PRINTER_ROLES, type PrinterDraft, type WizardDraft } from '@shared/setup/draft'
import type { Profile } from '../../../infrastructure/profile/profile-io'

const kindOf = (kind: string): PrinterDraft['kind'] => ((PRINTER_KINDS as readonly string[]).includes(kind) ? (kind as PrinterDraft['kind']) : 'virtual')
const roleOf = (role: string): PrinterDraft['role'] => ((PRINTER_ROLES as readonly string[]).includes(role) ? (role as PrinterDraft['role']) : 'receipt')

/**
 * Pre-fills a draft from a profile: the business type, modules, settings, receipt texts, languages, printers
 * (a printer other than `network` comes without its device: the Matériel step asks for it) and routing; the
 * catalogue source becomes `profile`. Users, backups, the technician code and files are the machine's and are
 * left as they are. The legal identity is taken over but flagged `legalFromProfile`: it must be confirmed.
 */
export function applyProfileToDraft(draft: WizardDraft, profile: Profile): WizardDraft {
  const s = profile.settings
  const legal = s['business.legal']
  return {
    ...draft,
    step: 1,
    startMode: 'profile',
    businessType: s['business.type'] ?? draft.businessType,
    modules: profile.modules,
    catalogSource: 'profile',
    ...(legal ? { legal: { ...legal } } : {}),
    legalFromProfile: legal !== undefined,
    vatRates: s['vat.rates'] ?? draft.vatRates,
    receiptHeader: s['receipt.header'] ?? draft.receiptHeader,
    receiptFooter: s['receipt.footer'] ?? draft.receiptFooter,
    lang: { ...draft.lang, receipt: s['receipt.lang'] ?? draft.lang.receipt, staffDefault: s['ui.defaultLang'] ?? draft.lang.staffDefault },
    printers: profile.printers.map((p) => ({
      tempId: p.code,
      name: p.name,
      kind: kindOf(p.kind),
      address: p.address ?? '',
      widthMm: p.width_mm === 58 ? 58 : 80,
      lang: p.lang,
      raster: p.raster,
      role: roleOf(p.role),
      active: p.active
    })),
    routing: Object.fromEntries(Object.entries(profile.routing).map(([category, codes]) => [category, [...codes]])),
    customerDisplay: s['display.customerEnabled'] ?? draft.customerDisplay,
    kiosk: s['kiosk.enabled'] ?? draft.kiosk,
    autostart: s['autostart.enabled'] ?? draft.autostart,
    backofficePort: s['backoffice.port'] ?? draft.backofficePort,
    backupSchedule: {
      continuous: s['backup.continuous'] ?? draft.backupSchedule.continuous,
      onClose: s['backup.onClose'] ?? draft.backupSchedule.onClose,
      retentionDays: s['backup.retentionDays'] ?? draft.backupSchedule.retentionDays
    }
  }
}
