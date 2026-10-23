import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import { Logo } from './Logo'
import { Pill, type PillTone } from './Pill'
import { cx } from './metrics'

export type BackupStatus = 'ok' | 'pending' | 'warning' | 'error'
export type PrinterStatus = 'ok' | 'offline' | 'error'

export interface TopBarUser {
  name: string
  initials?: string
}

export interface TopBarProps {
  /** The screen's name ("Prise de commande"), after the logo. */
  title?: ReactNode
  /** A small tag beside the title (the table: "T4"). */
  badge?: ReactNode
  /** The signed-in user; omit it on the login and setup screens. */
  user?: TopBarUser | null
  onUserClick?: () => void
  /** `true` shows the live time; a string shows that text (a test, or a custom format). */
  clock?: boolean | string
  backupStatus?: BackupStatus
  printerStatus?: PrinterStatus
  /** The middle: a Tabs `bar` variant, or navigation buttons. */
  children?: ReactNode
  /** Actions at the end, before the status pills ("Retour aux tables"). */
  end?: ReactNode
  /** A 0.8 s press on the logo: the technician menu. */
  onLogoLongPress?: () => void
  className?: string
}

const BACKUP_TONE: Record<BackupStatus, PillTone> = { ok: 'success', pending: 'neutral', warning: 'warning', error: 'danger' }
const PRINTER_TONE: Record<PrinterStatus, PillTone> = { ok: 'success', offline: 'warning', error: 'danger' }

const timeFormat = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** The current time, `HH:mm`, refreshed every 15 s. */
export function useClock(enabled = true): string {
  const [now, setNow] = useState(() => timeFormat.format(new Date()))
  useEffect(() => {
    if (!enabled) return
    const tick = () => setNow(timeFormat.format(new Date()))
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export function TopBar({ title, badge, user, onUserClick, clock, backupStatus, printerStatus, children, end, onLogoLongPress, className }: TopBarProps) {
  const { t } = useTranslation()
  const live = useClock(clock === true)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPress = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }
  useEffect(() => clearPress, [])

  const person = user && (
    <>
      <span className="topbar__avatar" aria-hidden="true">
        {user.initials ?? user.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="topbar__user-name">{user.name}</span>
    </>
  )

  return (
    <header className={cx('topbar', className)}>
      <div
        className="topbar__brand"
        onPointerDown={() => {
          if (!onLogoLongPress) return
          clearPress()
          press.current = setTimeout(onLogoLongPress, 800)
        }}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Logo />
      </div>
      {title && (
        <div className="topbar__title">
          <span>{title}</span>
          {badge && <span className="topbar__badge">{badge}</span>}
        </div>
      )}
      <div className="topbar__center">{children}</div>
      <div className="topbar__end">
        {end}
        {backupStatus && (
          <Pill tone={BACKUP_TONE[backupStatus]} dot onDark>
            {t(`status.backup.${backupStatus}`)}
          </Pill>
        )}
        {printerStatus && (
          <Pill tone={PRINTER_TONE[printerStatus]} icon="printer" onDark>
            {t(`status.printer.${printerStatus}`)}
          </Pill>
        )}
        {clock && <span className="topbar__clock figure">{typeof clock === 'string' ? clock : live}</span>}
        {user &&
          (onUserClick ? (
            <button type="button" className="topbar__user" onClick={onUserClick} aria-label={`${t('topbar.user')} ${user.name}`}>
              {person}
              <Icon name="chevron" size={22} />
            </button>
          ) : (
            <span className="topbar__user topbar__user--static">{person}</span>
          ))}
      </div>
    </header>
  )
}
