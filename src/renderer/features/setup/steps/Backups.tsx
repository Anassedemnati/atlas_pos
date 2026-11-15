import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../../app/api'
import { BACKUP_ROLES, type BackupDraft } from '@shared/setup/draft'
import { Button, Card, ConfirmDialog, Icon, Pill, Select, TextField, Toggle, useToast, type IconName } from '../../../ui'
import { Banner } from '../components/Banner'
import { usePickers } from '../components/useFilePicker'
import { Section } from '../components/Section'
import { useWizard } from '../wizard-context'

type Role = (typeof BACKUP_ROLES)[number]
type Status = { path: string; state: 'ok' | 'failed'; bytes?: number; message?: string }

const ICONS: Record<Role, IconName> = { disk: 'disk', usb: 'usb', nas: 'nas' }
const RETENTION = [7, 14, 30, 60, 90, 180, 365]
const CHECKLIST = ['bios', 'autologin', 'sleep'] as const

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} Go`

/** Step 6: backup destinations (each tested), schedule, resilience, and the technician's checklist. */
export function Backups() {
  const { t } = useTranslation()
  const toast = useToast()
  const { draft, edit, errors, api } = useWizard()
  const { pickFolder } = usePickers()
  const [status, setStatus] = useState<Partial<Record<Role, Status>>>({})
  const [testing, setTesting] = useState<Role | null>(null)
  const [conflict, setConflict] = useState<Role | null>(null)
  const [ticked, setTicked] = useState<Record<string, boolean>>({})

  const entryOf = (role: Role): { entry: BackupDraft; index: number } | null => {
    const index = draft.backups.findIndex((backup) => backup.role === role)
    return index < 0 ? null : { entry: draft.backups[index]!, index }
  }

  const update = (role: Role, patch: Partial<BackupDraft>) =>
    edit((state) => ({ backups: state.backups.map((backup) => (backup.role === role ? { ...backup, ...patch } : backup)) }))

  const setEnabled = (role: Role, enabled: boolean) => {
    if (!enabled) edit((state) => ({ backups: state.backups.filter((backup) => backup.role !== role) }))
    else edit((state) => ({ backups: [...state.backups, { role, path: '', label: t(`setupWizard.backups.roles.${role}`) }] }))
    setStatus((previous) => ({ ...previous, [role]: undefined }))
  }

  const setPath = (role: Role, path: string) => {
    update(role, { path })
    setStatus((previous) => (previous[role]?.path === path ? previous : { ...previous, [role]: undefined }))
  }

  const browse = async (role: Role) => {
    const folder = await pickFolder(t(`setupWizard.backups.roles.${role}`))
    if (folder) setPath(role, folder)
  }

  const test = async (role: Role, overwrite = false) => {
    const found = entryOf(role)
    if (!found || found.entry.path.trim() === '') {
      toast.warning(t('setupWizard.backups.choosePath'))
      return
    }
    const { entry } = found
    setTesting(role)
    const result = await api.call(
      'setup.testBackupTarget',
      { role, path: entry.path, label: entry.label, ...(entry.targetKey ? { targetKey: entry.targetKey } : {}), ...(overwrite ? { overwrite: true } : {}) },
      { silent: true }
    )
    setTesting(null)
    if (result.ok) {
      update(role, { targetKey: result.value.targetKey })
      setStatus((previous) => ({ ...previous, [role]: { path: entry.path, state: 'ok', bytes: result.value.writableBytes } }))
      return
    }
    if (result.error.code === 'marker_conflict') {
      setConflict(role)
      return
    }
    const message = errorMessage(result.error)
    setStatus((previous) => ({ ...previous, [role]: { path: entry.path, state: 'failed', message } }))
    toast.error(message)
  }

  const schedule = draft.backupSchedule

  return (
    <div className="stack wiz-stack">
      {draft.backups.length === 0 && <Banner tone="info">{t('setupWizard.backups.noneHint')}</Banner>}
      <div className="wiz-grid wiz-grid--3">
        {BACKUP_ROLES.map((role) => {
          const found = entryOf(role)
          const result = status[role]
          const error = found ? errors[`backups.${found.index}.path`] : undefined
          return (
            <Card key={role} className="wiz-backup" data-testid={`backup-${role}`}>
              <div className="wiz-backup__head">
                <Icon name={ICONS[role]} size={40} />
                <div className="grow">
                  <strong>{t(`setupWizard.backups.roles.${role}`)}</strong>
                  <p className="muted wiz-backup__hint">{t(`setupWizard.backups.rolesHint.${role}`)}</p>
                </div>
              </div>
              <Toggle label={t('setupWizard.backups.use')} checked={found !== null} onChange={(checked) => setEnabled(role, checked)} />
              {found && (
                <div className="stack">
                  <TextField
                    label={t('setupWizard.backups.path')}
                    value={found.entry.path}
                    onChange={(value) => setPath(role, value)}
                    error={error}
                    placeholder={t(`setupWizard.backups.placeholder.${role}`)}
                    keyboard="azerty"
                    autoCapitalize="none"
                  />
                  <div className="cluster">
                    <Button variant="secondary" onClick={() => void browse(role)} data-testid={`backup-browse-${role}`}>
                      {t('setupWizard.backups.browse')}
                    </Button>
                    <Button variant="ghost" onClick={() => void test(role)} disabled={testing !== null} data-testid={`backup-test-${role}`}>
                      {testing === role ? t('common.loading') : t('common.test')}
                    </Button>
                  </div>
                  <div>
                    {result?.state === 'ok' && (
                      <Pill tone="success" icon="check">
                        {t('setupWizard.backups.tested', { size: gigabytes(result.bytes ?? 0) })}
                      </Pill>
                    )}
                    {result?.state === 'failed' && <Pill tone="danger" icon="warning">{t('setupWizard.backups.testFailed')}</Pill>}
                    {!result && found.entry.path.trim() !== '' && <Pill tone="warning">{t('setupWizard.backups.notTested')}</Pill>}
                  </div>
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <div className="wiz-grid wiz-grid--2">
        <Section title={t('setupWizard.backups.schedule')}>
          <div className="stack">
            <Toggle label={t('setupWizard.backups.continuous')} checked={schedule.continuous} onChange={(checked) => edit({ backupSchedule: { ...schedule, continuous: checked } })} />
            <Toggle label={t('setupWizard.backups.onClose')} checked={schedule.onClose} onChange={(checked) => edit({ backupSchedule: { ...schedule, onClose: checked } })} />
            <Select
              label={t('setupWizard.backups.retention')}
              value={String(schedule.retentionDays)}
              options={[...new Set([...RETENTION, schedule.retentionDays])].sort((a, b) => a - b).map((days) => ({ value: String(days), label: t('setupWizard.backups.days', { count: days }) }))}
              onChange={(value) => edit({ backupSchedule: { ...schedule, retentionDays: Number(value) } })}
            />
          </div>
        </Section>
        <Section title={t('setupWizard.backups.resilience')}>
          <div className="stack">
            <Toggle label={t('setupWizard.backups.autostart')} checked={draft.autostart} onChange={(checked) => edit({ autostart: checked })} />
            <Toggle label={t('setupWizard.backups.kiosk')} checked={draft.kiosk} onChange={(checked) => edit({ kiosk: checked })} />
            <TextField
              label={t('setupWizard.backups.port')}
              hint={t('setupWizard.backups.portHint')}
              value={String(draft.backofficePort)}
              onChange={(value) => edit({ backofficePort: Number(value.replace(/\D/g, '').slice(0, 5)) || 0 })}
              error={errors['backofficePort']}
              inputMode="numeric"
            />
          </div>
        </Section>
      </div>

      <Section title={t('setupWizard.backups.checklist')} hint={t('setupWizard.backups.checklistHint')}>
        <ul className="wiz-checklist">
          {CHECKLIST.map((item) => (
            <li key={item}>
              <button type="button" role="checkbox" aria-checked={ticked[item] === true} className={`wiz-check${ticked[item] ? ' wiz-check--on' : ''}`} onClick={() => setTicked((previous) => ({ ...previous, [item]: !previous[item] }))}>
                <span className="wiz-check__box" aria-hidden="true">
                  {ticked[item] && <Icon name="check" size={24} strokeWidth={3} />}
                </span>
                <span>{t(`setupWizard.backups.check.${item}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <ConfirmDialog
        open={conflict !== null}
        tone="danger"
        title={t('setupWizard.backups.conflictTitle')}
        message={t('errors.marker_conflict')}
        confirmLabel={t('setupWizard.backups.overwrite')}
        onCancel={() => setConflict(null)}
        onConfirm={() => {
          const role = conflict
          setConflict(null)
          if (role) void test(role, true)
        }}
      />
    </div>
  )
}
