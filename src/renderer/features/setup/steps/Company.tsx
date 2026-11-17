import { useTranslation } from 'react-i18next'
import type { WizardDraft } from '@shared/setup/draft'
import { Button, Icon, Pill, TextField } from '../../../ui'
import { Banner } from '../components/Banner'
import { Chip } from '../components/Chip'
import { ReceiptPreview } from '../components/ReceiptPreview'
import { Section } from '../components/Section'
import { usePickers } from '../components/useFilePicker'
import { useWizard } from '../wizard-context'

const VAT_CHOICES = [2000, 1400, 1000, 700, 0] as const
type LegalKey = keyof WizardDraft['legal']

/** Step 3: legal identity, logo, VAT rates, ticket texts, with the ticket drawn live beside the form. */
export function Company() {
  const { t } = useTranslation()
  const { draft, saved, edit, errors, api, adopt } = useWizard()
  const { pickFile } = usePickers()
  const { legal } = draft

  const field = (key: LegalKey, options: { numeric?: number; wide?: boolean } = {}) => (
    <TextField
      key={key}
      className={options.wide ? 'wiz-form__wide' : undefined}
      label={key === 'nomCommercial' ? `${t(`setupWizard.company.${key}`)} *` : t(`setupWizard.company.${key}`)}
      value={legal[key]}
      onChange={(value) => edit((state) => ({ legal: { ...state.legal, [key]: options.numeric ? value.replace(/\D/g, '').slice(0, options.numeric) : value } }))}
      error={errors[`legal.${key}`]}
      {...(options.numeric ? { inputMode: 'numeric' as const, maxLength: options.numeric, hint: t(`setupWizard.company.${key}Hint`) } : {})}
    />
  )

  const chooseLogo = async () => {
    const path = await pickFile(t('setupWizard.company.logoTitle'), ['png', 'jpg', 'jpeg', 'webp', 'svg'])
    if (!path) return
    const result = await api.call('setup.pickLogo', { path })
    if (result.ok) adopt(result.value, { keepEdits: true })
  }

  const toggleRate = (rate: number) =>
    edit((state) => {
      const has = state.vatRates.includes(rate)
      if (has && state.vatRates.length === 1) return {}
      const set = new Set(has ? state.vatRates.filter((value) => value !== rate) : [...state.vatRates, rate])
      return { vatRates: [...VAT_CHOICES, ...state.vatRates].filter((value, index, all) => set.has(value) && all.indexOf(value) === index) }
    })

  return (
    <div className="wiz-company">
      <div className="stack wiz-stack">
        {saved.legalFromProfile && <Banner tone="warning">{t('setupWizard.company.fromProfile')}</Banner>}
        {errors['legal'] && !saved.legalFromProfile && <Banner tone="warning">{errors['legal']}</Banner>}
        <Section>
          <div className="wiz-form">
            {field('nomCommercial')}
            {field('raisonSociale')}
            {field('adresse')}
            {field('ville')}
            {field('telephone')}
            {field('ice', { numeric: 15 })}
            {field('if')}
            {field('rc')}
            {field('patente')}
          </div>
        </Section>
        <Section title={t('setupWizard.company.logo')} hint={t('setupWizard.company.logoHint')}>
          <div className="cluster">
            <Button variant="ghost" icon="plus" onClick={() => void chooseLogo()}>
              {saved.logoPath ? t('setupWizard.company.logoChange') : t('setupWizard.company.logoAdd')}
            </Button>
            {saved.logoPath && (
              <Pill tone="success" icon="check">
                {t('setupWizard.company.logoKept')}
              </Pill>
            )}
          </div>
        </Section>
        <Section title={t('setupWizard.company.vat')} hint={t('setupWizard.company.vatHint')} end={<Pill tone="neutral">{t('setupWizard.company.currency')}</Pill>}>
          <div className="cluster" role="group" aria-label={t('setupWizard.company.vat')}>
            {VAT_CHOICES.map((rate) => (
              <Chip key={rate} selected={draft.vatRates.includes(rate)} onClick={() => toggleRate(rate)}>
                {rate / 100} %
              </Chip>
            ))}
          </div>
          {errors['vatRates'] && (
            <p className="field__message field__message--error" role="alert">
              <Icon name="warning" size={20} />
              {errors['vatRates']}
            </p>
          )}
        </Section>
        <Section title={t('setupWizard.company.texts')}>
          <div className="wiz-form">
            <TextField label={t('setupWizard.company.header')} value={draft.receiptHeader} onChange={(value) => edit({ receiptHeader: value })} maxLength={200} />
            <TextField label={t('setupWizard.company.footer')} value={draft.receiptFooter} onChange={(value) => edit({ receiptFooter: value })} maxLength={200} />
          </div>
        </Section>
      </div>
      <aside className="wiz-company__preview">
        <ReceiptPreview draft={draft} logoPath={saved.logoPath} />
      </aside>
    </div>
  )
}
