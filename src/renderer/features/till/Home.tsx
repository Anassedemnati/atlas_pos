import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../ui'
import { navigate } from '../../app/router'
import { loadTillData, moduleOn } from './store'

/** `#/home`: the start screen of the signed-in user: the floor plan with tables, else the counter. */
export function Home() {
  const { t } = useTranslation()
  useEffect(() => {
    let cancelled = false
    void loadTillData().then((data) => {
      if (cancelled) return
      navigate(data === null ? '/login' : moduleOn(data, 'tables') ? '/floor' : '/counter')
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <EmptyState title={t('app.loading')} />
}
