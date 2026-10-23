import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TillUserDto } from '@shared/dto'
import { errorMessage, invoke } from '../../app/api'
import { LANGS, setLanguage } from '../../app/i18n'
import { navigate } from '../../app/router'
import { Button, EmptyState, Keypad, Logo } from '../../ui'
import { clearTillData } from '../till/store'

/** Seconds left until an ISO instant (0 when past). */
const secondsUntil = (iso: string): number => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))

/** The till's front door: a tile per user, then a PIN keypad. Five wrong PINs lock the user for a minute. */
export function Login() {
  const { t, i18n } = useTranslation()
  const [users, setUsers] = useState<TillUserDto[] | null>(null)
  const [selected, setSelected] = useState<TillUserDto | null>(null)
  const [pin, setPin] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const current = await invoke('users.current', {})
      if (current.ok && current.value) return navigate('/home')
      const list = await invoke('users.listTill', {})
      if (!cancelled) setUsers(list.ok ? list.value : [])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!lockedUntil) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [lockedUntil])

  const remaining = lockedUntil ? secondsUntil(lockedUntil) : 0
  void now
  const locked = remaining > 0

  useEffect(() => {
    if (lockedUntil && !locked) {
      setLockedUntil(null)
      setMessage(null)
    }
  }, [lockedUntil, locked])

  const submit = async (value: string) => {
    if (!selected || busy || locked) return
    setBusy(true)
    const result = await invoke('users.loginPin', { userId: selected.id, pin: value })
    setBusy(false)
    if (result.ok) {
      clearTillData()
      await setLanguage(result.value.lang)
      navigate('/home')
      return
    }
    setPin('')
    if (result.error.code === 'locked' && typeof result.error.params?.['until'] === 'string') {
      setLockedUntil(result.error.params['until'])
      setNow(Date.now())
      setMessage(null)
    } else if (result.error.code === 'invalid_credentials') {
      setMessage(t('login.wrongPin'))
    } else {
      setMessage(errorMessage(result.error))
    }
  }

  const choose = (user: TillUserDto | null) => {
    setSelected(user)
    setPin('')
    setMessage(null)
    setLockedUntil(null)
  }

  return (
    <div className="login">
      <header className="login__bar">
        <Logo />
        <div className="cluster">
          {LANGS.map((lang) => (
            <Button key={lang} variant={i18n.language === lang ? 'primary' : 'secondary'} onClick={() => void setLanguage(lang)} data-testid={`login-lang-${lang}`}>
              {t(`lang.${lang}`)}
            </Button>
          ))}
        </div>
      </header>
      <main className="login__main">
        {users === null ? (
          <EmptyState title={t('app.loading')} />
        ) : users.length === 0 ? (
          <EmptyState icon="user" title={t('login.noUsers')} />
        ) : (
          <div className={selected ? 'login__panel login__panel--pin' : 'login__panel'}>
            <section className="login__users">
              <h1 className="h2">{selected ? selected.displayName : t('login.choose')}</h1>
              <div className="login__tiles" data-testid="login-users">
                {users.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className={user.id === selected?.id ? 'user-tile user-tile--selected' : 'user-tile'}
                    onClick={() => choose(user)}
                    data-testid={`user-${user.displayName}`}
                  >
                    <span className="user-tile__avatar">{user.initials}</span>
                    <span className="user-tile__name">{user.displayName}</span>
                  </button>
                ))}
              </div>
            </section>
            {selected && (
              <section className="login__pin">
                <p className="muted">{t('login.enterPin')}</p>
                <Keypad mode="pin" value={pin} onChange={setPin} onEnter={(value) => void submit(value)} invalid={!!message || locked} captureKeys disabled={busy || locked} />
                <p className="login__message" role="alert" data-testid="login-message">
                  {locked ? t('login.locked', { seconds: remaining }) : message}
                </p>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
