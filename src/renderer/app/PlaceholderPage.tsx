import { useTranslation } from 'react-i18next'
import { EmptyState, TopBar } from '../ui'

export interface PlaceholderPageProps {
  /** i18n key of the screen's name (`routes.setup`). */
  titleKey: string
  /** No top bar (the customer display). */
  bare?: boolean
}

/** Stands in for a screen that a later task builds. Replace the route's component, not this file. */
export function PlaceholderPage({ titleKey, bare }: PlaceholderPageProps) {
  const { t } = useTranslation()
  return (
    <div className="page">
      {!bare && <TopBar title={t(titleKey)} />}
      <div className="page__body" style={{ display: 'grid', placeItems: 'center' }}>
        <EmptyState icon="gear" title={t(titleKey)} hint={t('routes.placeholder')} />
      </div>
    </div>
  )
}
