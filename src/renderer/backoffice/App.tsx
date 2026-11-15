import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfoDto } from '@shared/dto/backoffice'
import { LANGS, setLanguage } from '../app/i18n'
import { Router, navigate, parseHash, useHash, type RouteDef, type RouteProps } from '../app/router'
import { Button, EmptyState, Icon, Logo, Select, TillKeyboardProvider, ToastProvider, type IconName } from '../ui'
import { http, SessionProvider, setCsrfToken, setSignedOutHandler, useSession } from './api'
import { Backups } from './pages/Backups'
import { Categories } from './pages/Categories'
import { Dashboard } from './pages/Dashboard'
import { Journal } from './pages/Journal'
import { Keyboards } from './pages/Keyboards'
import { Login } from './pages/Login'
import { Menus } from './pages/Menus'
import { Printers } from './pages/Printers'
import { Products } from './pages/Products'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'
import { Users } from './pages/Users'

interface Section {
  path: string
  key: string
  icon: IconName
  component: ComponentType<RouteProps>
}

/** The sections of the sidebar, in the order of the mockup. */
const SECTIONS: Section[] = [
  { path: '/dashboard', key: 'dashboard', icon: 'chart', component: Dashboard },
  { path: '/products', key: 'products', icon: 'store', component: Products },
  { path: '/categories', key: 'categories', icon: 'table', component: Categories },
  { path: '/menus', key: 'menus', icon: 'utensils', component: Menus },
  { path: '/keyboards', key: 'keyboards', icon: 'barcode', component: Keyboards },
  { path: '/users', key: 'users', icon: 'user', component: Users },
  { path: '/printers', key: 'printers', icon: 'printer', component: Printers },
  { path: '/backups', key: 'backups', icon: 'disk', component: Backups },
  { path: '/reports', key: 'reports', icon: 'percent', component: Reports },
  { path: '/settings', key: 'settings', icon: 'gear', component: Settings },
  { path: '/journal', key: 'journal', icon: 'lock', component: Journal }
]

const routes: RouteDef[] = SECTIONS.map(({ path, component }) => ({ path, component }))

function Home() {
  useEffect(() => navigate('/dashboard'), [])
  return null
}

function Frame() {
  const { t, i18n } = useTranslation()
  const { user, signOut } = useSession()
  const current = parseHash(useHash()).path
  return (
    <div className="bo-shell">
      <header className="bo-topbar">
        <Logo />
        <span className="bo-topbar__title muted">{t('bo.title')}</span>
        <div className="bo-topbar__end">
          <div className="bo-lang" role="group" aria-label={t('common.language')}>
            {LANGS.map((lang) => (
              <button key={lang} type="button" className={i18n.language === lang ? 'bo-lang__item bo-lang__item--on' : 'bo-lang__item'} onClick={() => void setLanguage(lang)} data-testid={`lang-${lang}`}>
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="bo-topbar__user" data-testid="signed-in-as">
            <Icon name="user" size={22} />
            {t('bo.signedInAs', { name: user.displayName })}
          </span>
          <Button variant="secondary" size="md" icon="logout" onClick={signOut} data-testid="sign-out">
            {t('bo.signOut')}
          </Button>
        </div>
      </header>
      <div className="bo-body">
        <nav className="bo-nav" aria-label={t('bo.title')}>
          {SECTIONS.map((section) => (
            <a key={section.path} href={`#${section.path}`} className={current === section.path ? 'bo-nav__item bo-nav__item--on' : 'bo-nav__item'} data-testid={`nav-${section.key}`} aria-current={current === section.path ? 'page' : undefined}>
              <Icon name={section.icon} size={26} />
              <span>{t(`bo.nav.${section.key}`)}</span>
            </a>
          ))}
        </nav>
        <main className="bo-main">
          <Router routes={routes} fallback={Home} />
        </main>
      </div>
    </div>
  )
}

type Auth = { state: 'checking' } | { state: 'out' } | { state: 'in'; user: SessionInfoDto['user'] }

function Gate() {
  const { t } = useTranslation()
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })

  const signedOut = useCallback(() => {
    setCsrfToken('')
    setAuth({ state: 'out' })
  }, [])
  useEffect(() => setSignedOutHandler(signedOut), [signedOut])

  useEffect(() => {
    let cancelled = false
    void http<SessionInfoDto>('GET', '/api/auth/me').then((result) => {
      if (cancelled) return
      if (result.ok) {
        setCsrfToken(result.value.csrfToken)
        setAuth({ state: 'in', user: result.value.user })
      } else setAuth({ state: 'out' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const signOut = useCallback(() => {
    void http('POST', '/api/auth/logout').then(signedOut)
  }, [signedOut])

  if (auth.state === 'checking') return <EmptyState title={t('app.starting')} />
  if (auth.state === 'out') {
    return (
      <Login
        onSignedIn={(info) => {
          setCsrfToken(info.csrfToken)
          window.location.hash = '#/dashboard'
          setAuth({ state: 'in', user: info.user })
        }}
      />
    )
  }
  return (
    <SessionProvider value={{ user: auth.user, signOut }}>
      <Frame />
    </SessionProvider>
  )
}

/** The back office: providers (toasts; no on-screen keyboard, a computer has its own), then the sign-in gate. */
export function App() {
  return (
    <ToastProvider>
      <TillKeyboardProvider till={false}>
        <Gate />
      </TillKeyboardProvider>
    </ToastProvider>
  )
}
