import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackupStatusDto, DayGateDto, PrintJobDto } from '@shared/dto'
import { useQuery } from '../../app/api'
import { invoke } from '../../app/api'
import { LANGS, setLanguage } from '../../app/i18n'
import { Button, EmptyState, Modal, TopBar, type BackupStatus, type PrinterStatus } from '../../ui'
import { TechMenu } from '../tech/TechMenu'
import { OverrideProvider } from './Override'
import { PrevDayGate } from './PrevDayGate'
import { PrinterJobsDialog } from './PrinterJobsDialog'
import { setting, signOut, TillContext, useTillLoader } from './store'

export interface TillLayoutProps {
  /** The screen's name, after the business name. */
  title?: ReactNode
  badge?: ReactNode
  /** The middle of the top bar: tabs or navigation buttons. */
  nav?: ReactNode
  /** Actions at the end of the top bar, before the status pills. */
  end?: ReactNode
  children: ReactNode
}

const LOGO_PRESS_MS = 3000

function backupStatusOf(status: BackupStatusDto | undefined): BackupStatus {
  if (!status) return 'pending'
  if (status.overall === 'error') return 'error'
  if (status.overall === 'warning') return 'warning'
  return status.lastOkAt ? 'ok' : 'pending'
}

/**
 * The frame of every till screen: the top bar (business, user menu, clock, backup and printer status), the
 * auto-lock, the previous-day gate, the manager-approval prompt and the technician menu (3 s on the logo).
 */
export function TillLayout({ title, badge, nav, end, children }: TillLayoutProps) {
  const { t, i18n } = useTranslation()
  const data = useTillLoader()
  const [menu, setMenu] = useState(false)
  const [tech, setTech] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const backup = useQuery('backup.status', {}, { silent: true, refreshOn: ['backup.status'], enabled: !!data })
  const jobs = useQuery('printing.jobs', {}, { silent: true, refreshOn: ['print.status'], enabled: !!data })
  const gate = useQuery('days.gate', {}, { silent: true, refreshOn: ['day.closed', 'ticket.closed'], enabled: !!data })
  const [gateDismissed, setGateDismissed] = useState(false)

  const lockSeconds = data ? setting(data, 'till.autoLockSeconds', 120) : 0
  useEffect(() => {
    if (!lockSeconds) return
    let timer = setTimeout(() => void signOut(), lockSeconds * 1000)
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void signOut(), lockSeconds * 1000)
    }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }))
    return () => {
      clearTimeout(timer)
      events.forEach((name) => window.removeEventListener(name, reset))
    }
  }, [lockSeconds])

  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPress = useCallback(() => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }, [])
  useEffect(() => clearPress, [clearPress])

  if (data === undefined) return <EmptyState title={t('app.loading')} />
  if (data === null) return <EmptyState title={t('app.loading')} />

  const problemJobs: PrintJobDto[] = jobs.data ?? []
  // A failed or uncertain job is red; the pill is only shown when there is one (space in the top bar).
  const printerStatus: PrinterStatus = problemJobs.length > 0 ? 'error' : 'ok'
  const legal = setting<{ nomCommercial?: string }>(data, 'business.legal', {})
  const must: DayGateDto | undefined = gate.data

  return (
    <TillContext.Provider value={data}>
      <OverrideProvider>
        <div
          className="page till-frame"
          onPointerDownCapture={(event) => {
            if (!(event.target as HTMLElement).closest('.topbar__brand')) return
            clearPress()
            press.current = setTimeout(() => setTech(true), LOGO_PRESS_MS)
          }}
          onPointerUpCapture={clearPress}
          onPointerCancelCapture={clearPress}
          onPointerLeave={clearPress}
        >
          <TopBar
            title={title ?? legal.nomCommercial}
            badge={badge}
            user={{ name: data.session.displayName }}
            onUserClick={() => setMenu(true)}
            clock
            backupStatus={backupStatusOf(backup.data)}
            {...(printerStatus === 'ok' ? {} : { printerStatus })}
            end={
              <>
                {end}
                {problemJobs.length > 0 && (
                  <Button variant="secondary" icon="printer" onClick={() => setJobsOpen(true)} data-testid="print-problems">
                    {problemJobs.length}
                  </Button>
                )}
              </>
            }
          >
            {nav}
          </TopBar>
          <main className="till-main">{children}</main>
        </div>

        <Modal open={menu} onClose={() => setMenu(false)} title={data.session.displayName} size="sm">
          <div className="stack" data-testid="user-menu">
            <div>
              <p className="muted">{t('common.language')}</p>
              <div className="cluster" style={{ marginBlockStart: 8 }}>
                {LANGS.map((lang) => (
                  <Button
                    key={lang}
                    variant={i18n.language === lang ? 'primary' : 'secondary'}
                    data-testid={`lang-${lang}`}
                    onClick={() => {
                      void setLanguage(lang)
                      void invoke('users.setLang', { lang })
                    }}
                  >
                    {t(`lang.${lang}`)}
                  </Button>
                ))}
              </div>
            </div>
            <Button variant="secondary" size="lg" icon="user" block onClick={() => void signOut()} data-testid="switch-user">
              {t('till.switchUser')}
            </Button>
            <Button variant="secondary" size="lg" icon="lock" block onClick={() => void signOut()}>
              {t('till.lock')}
            </Button>
          </div>
        </Modal>

        <PrinterJobsDialog open={jobsOpen} jobs={problemJobs} onClose={() => setJobsOpen(false)} onChanged={jobs.reload} />
        {must?.state === 'must_close' && !gateDismissed && (
          <PrevDayGate gate={must} onContinue={() => setGateDismissed(true)} onClosed={gate.reload} />
        )}
        {tech && <TechMenu onClose={() => setTech(false)} />}
      </OverrideProvider>
    </TillContext.Provider>
  )
}
