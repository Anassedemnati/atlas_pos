import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackupItemDto, BackupsDto } from '@shared/dto/backoffice'
import { Button, Card, Pill, useToast, type PillTone } from '../../ui'
import { useApi, useQuery } from '../api'
import { ConfirmTyped } from '../components/ConfirmTyped'
import { PageHeader } from '../components/PageHeader'
import { useFormat } from '../format'

/** The word to type before a restore (the server checks it too). */
const RESTORE_WORD = 'RESTAURER'
const TONES: Record<string, PillTone> = { ok: 'success', pending: 'neutral', warning: 'warning', error: 'danger' }

/** Backup status per destination, a manual backup, the copies found (download) and the restore. */
export function Backups() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const query = useQuery<BackupsDto>('/api/backups')
  const [running, setRunning] = useState(false)
  const [restoring, setRestoring] = useState<BackupItemDto | null>(null)
  const [busy, setBusy] = useState(false)
  const data = query.data

  const run = async () => {
    setRunning(true)
    const result = await api.call<{ fileName: string; results: { ok: boolean }[] }>('POST', '/api/backups/run')
    setRunning(false)
    if (!result.ok) return
    toast[result.value.results.some((r) => !r.ok) ? 'warning' : 'success'](t('bo.backups.done'))
    query.reload()
  }

  const restore = async () => {
    if (!restoring) return
    setBusy(true)
    const result = await api.call('POST', '/api/backups/restore', { id: restoring.id, confirm: RESTORE_WORD })
    setBusy(false)
    if (!result.ok) return
    setRestoring(null)
    toast.success(t('bo.backups.restored'))
    // Everyone is signed out by a restore: start over from the sign-in page.
    setTimeout(() => window.location.reload(), 1500)
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.backups')}>
        <Button icon="disk" onClick={() => void run()} disabled={running} data-testid="backup-run">
          {t('bo.backups.runNow')}
        </Button>
      </PageHeader>

      {data && (
        <div className="bo-cards">
          <Card className="bo-card" data-testid="backup-status">
            <h2 className="h3">{t('bo.backups.status')}</h2>
            <Pill tone={TONES[data.status.overall] ?? 'neutral'} dot>
              {t(`bo.backups.overall.${data.status.overall}`)}
            </Pill>
            <p className="muted">{t('bo.dashboard.lastBackup', { when: f.dateTime(data.status.lastOkAt) })}</p>
            {data.status.lastError && <p className="error-text">{data.status.lastError}</p>}
          </Card>
          {data.status.perTarget.map((target) => (
            <Card key={target.id} className="bo-card">
              <h2 className="h3">{t(`bo.backups.roles.${target.role}`)}</h2>
              <Pill tone={TONES[target.state] ?? 'neutral'} dot>
                {t(`bo.backups.state.${target.state}`)}
              </Pill>
              <p className="muted">{t('bo.dashboard.lastBackup', { when: f.dateTime(target.lastOkAt) })}</p>
              {target.lastError && <p className="error-text">{target.lastError}</p>}
            </Card>
          ))}
        </div>
      )}

      <h2 className="h3">{t('bo.backups.copies')}</h2>
      <div className="bo-table-wrap">
        <table className="bo-table" data-testid="backups-table">
          <thead>
            <tr>
              <th>{t('bo.journal.when')}</th>
              <th>{t('bo.backups.kind')}</th>
              <th>{t('bo.backups.where')}</th>
              <th>{t('bo.backups.version')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((entry) => (
              <tr key={entry.id} data-testid="backup-entry">
                <td>{f.dateTime(entry.createdAt)}</td>
                <td>{t(`bo.backups.kinds.${entry.kind}`)}</td>
                <td>{t(`bo.backups.roles.${entry.role}`)}</td>
                <td className="muted">{entry.appVersion}</td>
                <td>
                  <div className="cluster">
                    <a className="bo-link" href={`/api/backups/${entry.id}/download`} download>
                      {t('bo.backups.download')}
                    </a>
                    <Button variant="danger" onClick={() => setRestoring(entry)} data-testid="backup-restore">
                      {t('bo.backups.restore')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {(data?.entries ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="muted bo-empty">
                  {query.loading ? t('common.loading') : t('bo.backups.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmTyped
        open={restoring !== null}
        title={t('bo.backups.restoreTitle')}
        message={restoring ? t('bo.backups.restoreMessage', { when: f.dateTime(restoring.createdAt) }) : ''}
        word={RESTORE_WORD}
        confirmLabel={t('bo.backups.restore')}
        busy={busy}
        onConfirm={() => void restore()}
        onCancel={() => setRestoring(null)}
      />
    </div>
  )
}
