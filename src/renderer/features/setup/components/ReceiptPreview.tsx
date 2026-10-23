import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@shared/names'
import { formatMoney } from '@shared/money'
import type { WizardDraft } from '@shared/setup/draft'
import i18n from '../../../app/i18n'

/** A path in the data directory as a `file:` URL (the renderer shows the copy the main process kept). */
export function fileUrl(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return encodeURI(`file://${slashed.startsWith('/') ? '' : '/'}${slashed}`).replace(/#/g, '%23')
}

const SAMPLE_CENTS = [3800, 3800]

/** The 80 mm ticket as the customer will get it, from what is typed (a sample sale, never real figures). */
export function ReceiptPreview({ draft, logoPath, width = 80 }: { draft: WizardDraft; logoPath?: string | undefined; width?: 58 | 80 }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState<string | null>(null)
  const lang: Lang = draft.lang.receipt
  const r = i18n.getFixedT(lang)
  const { legal } = draft
  const total = SAMPLE_CENTS.reduce((sum, cents) => sum + cents, 0)
  const name = legal.nomCommercial.trim() || legal.raisonSociale.trim() || t('setupWizard.company.previewName')
  const city = [legal.adresse.trim(), legal.ville.trim()].filter(Boolean)

  return (
    <section className="wiz-receipt" aria-label={t('setupWizard.company.preview')} data-width={width}>
      <header className="wiz-receipt__head">
        <h2 className="h3">{t('setupWizard.company.preview')}</h2>
        <span className="muted">{width} mm</span>
      </header>
      <div className="wiz-receipt__paper" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        {logoPath && broken !== logoPath && <img className="wiz-receipt__logo" src={fileUrl(logoPath)} alt="" onError={() => setBroken(logoPath)} />}
        <p className="wiz-receipt__name">{name}</p>
        {city.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {legal.telephone.trim() && <p>{legal.telephone.trim()}</p>}
        {legal.ice.trim() && <p>ICE : {legal.ice.trim()}</p>}
        {draft.receiptHeader.trim() && <p className="wiz-receipt__text">{draft.receiptHeader.trim()}</p>}
        <hr />
        {SAMPLE_CENTS.map((cents, index) => (
          <p key={index} className="wiz-receipt__line">
            <span>{r(`setupWizard.company.sample${index + 1}`)}</span>
            <span className="figure">{formatMoney(cents, lang)}</span>
          </p>
        ))}
        <hr />
        <p className="wiz-receipt__line wiz-receipt__total">
          <span>{r('setupWizard.company.totalTtc')}</span>
          <span className="figure">{formatMoney(total, lang)}</span>
        </p>
        <hr />
        {draft.receiptFooter.trim() && <p className="wiz-receipt__text">{draft.receiptFooter.trim()}</p>}
      </div>
    </section>
  )
}
