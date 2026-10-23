import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, TillKeyboardProvider, ToastProvider } from '../ui'
import { invoke } from './api'
import { routes } from './registry'
import { Router, navigate } from './router'

/**
 * What every window needs around its screens: toasts and, when `till` (the default), the on-screen
 * keyboard. The back office passes `till={false}`.
 */
export function AppProviders({ till = true, children }: { till?: boolean; children: ReactNode }) {
  return (
    <ToastProvider>
      <TillKeyboardProvider till={till}>{children}</TillKeyboardProvider>
    </ToastProvider>
  )
}

/** `/` (a window opened without a route): ask the main process where this run should start. */
function Boot() {
  const { t } = useTranslation()
  useEffect(() => {
    let cancelled = false
    void invoke('app.startupReport', {}).then((result) => {
      if (!cancelled) navigate(result.ok ? result.value.route : '#/recovery?mode=error')
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <EmptyState title={t('app.starting')} />
}

function NotFound() {
  const { t } = useTranslation()
  return <EmptyState icon="warning" title={t('app.notFound')} action={<Button onClick={() => navigate('#/')}>{t('common.back')}</Button>} />
}

/** `/` and any path no feature registered. */
function Fallback() {
  return window.location.hash.replace(/^#\/?/, '') === '' ? <Boot /> : <NotFound />
}

/** The till window: providers, then the screen the hash names. */
export function App() {
  return (
    <AppProviders>
      <div className="app-frame">
        <Router routes={routes} fallback={Fallback} />
      </div>
    </AppProviders>
  )
}
