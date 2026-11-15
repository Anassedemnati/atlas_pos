import { useTranslation } from 'react-i18next'
import { LANGS, setLanguage, type Lang } from '../../../app/i18n'
import { Card, Icon, Tabs } from '../../../ui'
import { Section } from '../components/Section'
import { useWizard } from '../wizard-context'

/** Step 1: the language of the setup screens, of the tickets, and the default for staff. */
export function Language() {
  const { t } = useTranslation()
  const { draft, edit } = useWizard()
  const tabs = LANGS.map((id) => ({ id, label: t(`lang.${id}`) }))

  return (
    <div className="stack wiz-stack">
      <Section title={t('setupWizard.language.setup')} hint={t('setupWizard.language.setupHint')}>
        <div className="wiz-grid wiz-grid--3">
          {LANGS.map((lang) => (
            <Card
              key={lang}
              selected={draft.lang.setup === lang}
              onClick={() => {
                void setLanguage(lang)
                edit((current) => ({ lang: { ...current.lang, setup: lang } }))
              }}
              className="wiz-lang"
              data-testid={`lang-${lang}`}
            >
              <Icon name="globe" size={36} />
              <span lang={lang}>{t(`lang.${lang}`)}</span>
              {draft.lang.setup === lang && <Icon name="check" size={28} strokeWidth={3} className="wiz-lang__check" />}
            </Card>
          ))}
        </div>
      </Section>
      <Section title={t('setupWizard.language.receipt')} hint={t('setupWizard.language.receiptHint')}>
        <Tabs
          tabs={tabs}
          value={draft.lang.receipt}
          onChange={(lang: Lang) => edit((current) => ({ lang: { ...current.lang, receipt: lang } }))}
          aria-label={t('setupWizard.language.receipt')}
        />
      </Section>
      <Section title={t('setupWizard.language.staff')} hint={t('setupWizard.language.staffHint')}>
        <Tabs
          tabs={tabs}
          value={draft.lang.staffDefault}
          onChange={(lang: Lang) => edit((current) => ({ lang: { ...current.lang, staffDefault: lang } }))}
          aria-label={t('setupWizard.language.staff')}
        />
      </Section>
    </div>
  )
}
