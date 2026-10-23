import { useTranslation } from 'react-i18next'
import type { DashboardDto } from '@shared/dto/backoffice'
import { Button, Card, EmptyState, Pill, type PillTone } from '../../ui'
import { useApi, useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { useFormat } from '../format'

const BACKUP_TONE: Record<string, PillTone> = { ok: 'success', pending: 'neutral', warning: 'warning', error: 'danger' }

/** Today's sales, the backup health and the printers. Refreshes by itself every 30 seconds. */
export function Dashboard() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const query = useQuery<DashboardDto>('/api/dashboard', { refreshMs: 30_000 })
  const data = query.data

  const backupNow = async () => {
    const result = await api.call('POST', '/api/backups/run')
    if (result.ok) query.reload()
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.dashboard')}>
        <Button variant="ghost" onClick={query.reload} disabled={query.loading}>
          {t('bo.refresh')}
        </Button>
      </PageHeader>
      {!data ? (
        <EmptyState title={t('common.loading')} />
      ) : (
        <div className="bo-cards">
          <Card className="bo-card" data-testid="dash-sales">
            <h2 className="h3">{t('bo.dashboard.sales')}</h2>
            {data.today ? (
              <>
                <p className="bo-figure" data-testid="dash-total">
                  {f.money(data.today.totalCents)}
                </p>
                <p className="muted">{t('bo.dashboard.tickets', { count: data.today.ticketsCount })}</p>
                <ul className="bo-list">
                  {data.today.byPayment.map((p) => (
                    <li key={p.methodCode}>
                      <span>{f.name(p.name)}</span>
                      <span className="figure">{f.money(p.cents)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">{data.day ? t('bo.dashboard.noFigures') : t('bo.dashboard.noDay')}</p>
            )}
          </Card>
          <Card className="bo-card" data-testid="dash-backup">
            <h2 className="h3">{t('bo.nav.backups')}</h2>
            {data.backup ? (
              <>
                <Pill tone={BACKUP_TONE[data.backup.overall] ?? 'neutral'} dot>
                  {t(`bo.backups.overall.${data.backup.overall}`)}
                </Pill>
                <p className="muted">{t('bo.dashboard.lastBackup', { when: f.dateTime(data.backup.lastOkAt) })}</p>
                {data.backup.lastError && <p className="error-text">{data.backup.lastError}</p>}
              </>
            ) : (
              <p className="muted">-</p>
            )}
            <Button variant="ghost" onClick={() => void backupNow()}>
              {t('bo.backups.runNow')}
            </Button>
          </Card>
          <Card className="bo-card" data-testid="dash-printers">
            <h2 className="h3">{t('bo.nav.printers')}</h2>
            <ul className="bo-list">
              {data.printers.map((printer) => (
                <li key={printer.id}>
                  <span>{printer.name}</span>
                  <Pill tone={printer.active ? 'success' : 'neutral'} dot>
                    {printer.active ? t('common.enabled') : t('common.disabled')}
                  </Pill>
                </li>
              ))}
            </ul>
            {data.jobs.length > 0 && (
              <p className="error-text" role="alert">
                {t('bo.dashboard.jobsAttention', { count: data.jobs.length })}
              </p>
            )}
          </Card>
          <Card className="bo-card">
            <h2 className="h3">{t('bo.dashboard.day')}</h2>
            <p>{data.day ? t('bo.dashboard.dayOpen', { number: data.day.number, since: f.dateTime(data.day.openedAt) }) : t('bo.dashboard.noDay')}</p>
            {data.version && <p className="muted">{t('bo.dashboard.version', { version: data.version })}</p>}
          </Card>
        </div>
      )}
    </div>
  )
}
