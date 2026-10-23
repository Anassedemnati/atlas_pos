import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppStatusDto, BackupEntryDto, RestoredOrderDto } from '@shared/dto'
import { errorMessage, invoke, useApi } from '../../app/api'
import { navigate, type RouteProps } from '../../app/router'
import { Button, ConfirmDialog, EmptyState, Icon, Logo } from '../../ui'
import { TechMenu } from '../tech/TechMenu'

const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

function Check({ children, tone = 'ok' }: { children: React.ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <li className={tone === 'ok' ? 'check check--ok' : 'check check--warn'}>
      <span className="check__icon">
        <Icon name={tone === 'ok' ? 'check' : 'warning'} size={26} strokeWidth={3} />
      </span>
      <span>{children}</span>
    </li>
  )
}

/** How a restored order is named: its table, else "n° 12", else a generic name and the end of its id. */
function restoredName(order: RestoredOrderDto, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (order.tableLabel) return /^\d+$/.test(order.tableLabel) ? `T${order.tableLabel}` : order.tableLabel
  if (order.orderNumber !== null) return t('recovery.orderNo', { number: order.orderNumber })
  return `${t('recovery.order')} …${order.idSuffix}`
}

/** `#/recovery`: the screen after a power cut (checks, restored orders), and the ones for a corrupt, newer or unreadable database, and safe mode. */
export function Recovery({ query }: RouteProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AppStatusDto | null>(null)
  useEffect(() => {
    void invoke('app.startupReport', {}).then((result) => result.ok && setStatus(result.value))
  }, [])
  const mode = query.get('mode') ?? 'recovered'
  const report = status?.report ?? null

  return (
    <div className="recovery">
      <header className="recovery__bar">
        <Logo />
      </header>
      <main className="recovery__main">
        {status === null ? (
          <EmptyState title={t('app.loading')} />
        ) : mode === 'recovered' ? (
          <Recovered report={report} />
        ) : mode === 'corrupt' ? (
          <Corrupt file={report?.corruptFile ?? null} />
        ) : mode === 'newer-schema' ? (
          <Newer found={report?.newerSchema?.found ?? 0} supported={report?.newerSchema?.supported ?? 0} />
        ) : (
          <SafeOrError mode={mode} error={status.startupError} />
        )}
      </main>
    </div>
  )
}

function Recovered({ report }: { report: AppStatusDto['report'] }) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState(false)
  const restored = report?.restoredOrders ?? []
  const names = restored.map((order) => restoredName(order, t))
  const ok = report?.integrity !== 'failed'
  return (
    <section className="recovery__card" data-testid="recovery">
      <span className="recovery__badge">
        <Icon name="lightning" size={72} />
      </span>
      <h1 className="h2">{t('recovery.title')}</h1>
      <p className="muted">{t('recovery.subtitle')}</p>
      <ul className="checks">
        <Check tone={ok ? 'ok' : 'warn'}>{ok ? t('recovery.integrityOk') : t('recovery.integrityFailed')}</Check>
        <Check>
          {restored.length === 0 ? t('recovery.noOrders') : t('recovery.ordersRestored', { count: restored.length, names: names.join(', ') })}
        </Check>
        <Check tone={report?.lastBackupAt ? 'ok' : 'warn'}>
          {report?.lastBackupAt ? t('recovery.lastBackup', { time: time.format(new Date(report.lastBackupAt)) }) : t('recovery.noBackup')}
        </Check>
        <Check>{t('recovery.noTicketLost')}</Check>
      </ul>
      {detail && (
        <ul className="plain-list" data-testid="recovery-orders">
          {restored.map((order) => (
            <li key={order.id} className="job-row">
              <strong>{restoredName(order, t)}</strong>
              <span className="muted"> · {t(`till.type.${order.type}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <Button size="xl" block icon="next" onClick={() => navigate('/login')} data-testid="recovery-continue">
        {t('recovery.continue')}
      </Button>
      <Button size="lg" variant="ghost" block onClick={() => setDetail(!detail)} disabled={restored.length === 0}>
        {t('common.details')}
      </Button>
    </section>
  )
}

function Corrupt({ file }: { file: string | null }) {
  const { t } = useTranslation()
  const api = useApi()
  const [backups, setBackups] = useState<BackupEntryDto[] | null>(null)
  const [pick, setPick] = useState<BackupEntryDto | null>(null)
  useEffect(() => {
    void invoke('backup.list', {}).then((result) => setBackups(result.ok ? result.value : []))
  }, [])
  const restore = async (entry: BackupEntryDto) => {
    setPick(null)
    // On success the main process reloads the till window on its route.
    await api.call('backup.restore', { file: entry.file })
  }
  return (
    <section className="recovery__card recovery__card--wide" data-testid="recovery-corrupt">
      <span className="recovery__badge recovery__badge--warn">
        <Icon name="warning" size={72} />
      </span>
      <h1 className="h2">{t('recovery.corruptTitle')}</h1>
      <p className="muted">{t('recovery.corruptMessage')}</p>
      {file && <p className="muted">{file}</p>}
      {backups === null ? (
        <p className="muted">{t('app.loading')}</p>
      ) : backups.length === 0 ? (
        <p className="warn-text">{t('recovery.noBackups')}</p>
      ) : (
        <ul className="plain-list">
          {backups.map((entry) => (
            <li key={entry.file} className="job-row">
              <span className="grow">
                <strong>{dateTime.format(new Date(entry.createdAt))}</strong>
                <span className="muted"> · {t(`recovery.kind.${entry.kind}`)} · {entry.role}</span>
              </span>
              <Button variant="secondary" onClick={() => setPick(entry)} data-testid="restore-backup">
                {t('recovery.restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button size="lg" variant="secondary" block onClick={() => void invoke('app.quitToDesktop', {})} data-testid="recovery-quit">
        {t('recovery.quit')}
      </Button>
      <ConfirmDialog
        open={pick !== null}
        tone="danger"
        title={t('recovery.restoreTitle')}
        message={t('recovery.restoreMessage')}
        confirmLabel={t('recovery.restore')}
        onCancel={() => setPick(null)}
        onConfirm={() => pick && void restore(pick)}
      />
    </section>
  )
}

function Newer({ found, supported }: { found: number; supported: number }) {
  const { t } = useTranslation()
  return (
    <section className="recovery__card" data-testid="recovery-newer">
      <span className="recovery__badge recovery__badge--warn">
        <Icon name="warning" size={72} />
      </span>
      <h1 className="h2">{t('recovery.updateRequired')}</h1>
      <p className="muted">{t('recovery.updateMessage', { found, supported })}</p>
      <Button size="lg" variant="secondary" block onClick={() => void invoke('app.quitToDesktop', {})}>
        {t('recovery.quit')}
      </Button>
    </section>
  )
}

function SafeOrError({ mode, error }: { mode: string; error: string | null }) {
  const { t } = useTranslation()
  const [tech, setTech] = useState(false)
  return (
    <section className="recovery__card" data-testid="recovery-safe">
      <span className="recovery__badge recovery__badge--warn">
        <Icon name="warning" size={72} />
      </span>
      <h1 className="h2">{mode === 'safe' ? t('recovery.safeTitle') : t('recovery.errorTitle')}</h1>
      <p className="muted">{mode === 'safe' ? t('recovery.safeMessage') : t('recovery.errorMessage')}</p>
      {error && <p className="error-text">{errorMessage({ code: error, messageKey: `errors.${error}` })}</p>}
      {mode === 'safe' ? (
        <>
          <Button size="xl" block icon="gear" onClick={() => setTech(true)} data-testid="recovery-tech">
            {t('recovery.technician')}
          </Button>
          <Button size="lg" variant="secondary" block onClick={() => navigate('/login')}>
            {t('recovery.tryLogin')}
          </Button>
        </>
      ) : (
        // No database is open: there is nobody to sign in and no technician mode, so the way out is the desktop.
        <Button size="xl" block icon="logout" onClick={() => void invoke('app.quitToDesktop', {})} data-testid="recovery-quit">
          {t('recovery.quit')}
        </Button>
      )}
      {tech && <TechMenu onClose={() => setTech(false)} />}
    </section>
  )
}
