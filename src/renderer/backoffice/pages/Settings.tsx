import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsDto } from '@shared/dto/backoffice'
import { formatMoney } from '@shared/money'
import type { Lang } from '@shared/names'
import { Button, Card, Select, Tabs, TextField, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { useFormat } from '../format'

const LEGAL_FIELDS = ['raisonSociale', 'nomCommercial', 'adresse', 'ville', 'telephone', 'ice', 'if', 'rc', 'patente'] as const
type LegalKey = (typeof LEGAL_FIELDS)[number]
type Legal = Record<LegalKey, string>

const BLANK_LEGAL: Legal = { raisonSociale: '', nomCommercial: '', adresse: '', ville: '', telephone: '', ice: '', if: '', rc: '', patente: '' }

type Tab = 'business' | 'receipt' | 'vat' | 'ui'

/** A sample sale on the receipt, in the receipt language: the two lines are the same as the setup wizard's. */
function ReceiptPreview({ legal, header, footer, lang }: { legal: Legal; header: string; footer: string; lang: Lang }) {
  const { t } = useTranslation()
  const r = (key: string): string => t(key, { lng: lang })
  const name = legal.nomCommercial.trim() || legal.raisonSociale.trim() || r('bo.settings.previewName')
  return (
    <section className="bo-receipt" aria-label={t('bo.settings.preview')} data-testid="receipt-preview" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <p className="bo-receipt__name">{name}</p>
      {[legal.adresse.trim(), legal.ville.trim()].filter(Boolean).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {legal.telephone.trim() && <p>{legal.telephone.trim()}</p>}
      {legal.ice.trim() && <p>ICE : {legal.ice.trim()}</p>}
      {header.trim() && <p className="bo-receipt__text">{header.trim()}</p>}
      <hr />
      <p className="bo-receipt__line">
        <span>{r('bo.settings.sample1')}</span>
        <span className="figure">{formatMoney(3800, lang)}</span>
      </p>
      <p className="bo-receipt__line">
        <span>{r('bo.settings.sample2')}</span>
        <span className="figure">{formatMoney(3800, lang)}</span>
      </p>
      <hr />
      <p className="bo-receipt__line bo-receipt__total">
        <span>Total</span>
        <span className="figure">{formatMoney(7600, lang)}</span>
      </p>
      {footer.trim() && <p className="bo-receipt__text">{footer.trim()}</p>}
    </section>
  )
}

/** The business identity and legal block, the receipt, the VAT rates (read only), the interface options. */
export function Settings() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const query = useQuery<SettingsDto>('/api/settings')
  const [tab, setTab] = useState<Tab>('business')
  const [legal, setLegal] = useState<Legal>(BLANK_LEGAL)
  const [receipt, setReceipt] = useState<{ lang: Lang; header: string; footer: string }>({ lang: 'fr', header: '', footer: '' })
  const [ui, setUi] = useState<{ defaultLang: Lang; ticketSide: 'start' | 'end'; keyStyle: 'color' | 'photo'; autoLock: string; cutover: string }>({ defaultLang: 'fr', ticketSide: 'start', keyStyle: 'color', autoLock: '120', cutover: '5' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const values = query.data?.values

  useEffect(() => {
    if (!values) return
    setLegal({ ...BLANK_LEGAL, ...(values['business.legal'] as Partial<Legal>) })
    setReceipt({ lang: values['receipt.lang'] as Lang, header: String(values['receipt.header'] ?? ''), footer: String(values['receipt.footer'] ?? '') })
    setUi({
      defaultLang: values['ui.defaultLang'] as Lang,
      ticketSide: values['ui.ticketSide'] as 'start' | 'end',
      keyStyle: values['ui.keyStyle'] as 'color' | 'photo',
      autoLock: String(values['till.autoLockSeconds']),
      cutover: String(values['day.cutoverHour'])
    })
  }, [values])

  const save = async (changes: Record<string, unknown>) => {
    const result = await api.call('PUT', '/api/settings', { changes })
    if (!result.ok) return
    toast.success(t('bo.saved'))
    query.reload()
  }

  const saveLegal = () => {
    const next: Record<string, string> = {}
    for (const key of LEGAL_FIELDS) if (legal[key].trim() === '') next[key] = t('common.required')
    if (!next['ice'] && !/^\d{15}$/.test(legal.ice.trim())) next['ice'] = t('bo.settings.errors.ice')
    setErrors(next)
    if (Object.keys(next).length === 0) void save({ 'business.legal': legal })
  }

  const saveUi = () => {
    const autoLock = Number(ui.autoLock)
    const cutover = Number(ui.cutover)
    const next: Record<string, string> = {}
    if (!Number.isInteger(autoLock) || autoLock < 1 || autoLock > 3600) next['autoLock'] = t('bo.settings.errors.autoLock')
    if (!Number.isInteger(cutover) || cutover < 0 || cutover > 23) next['cutover'] = t('bo.settings.errors.cutover')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    void save({ 'ui.defaultLang': ui.defaultLang, 'ui.ticketSide': ui.ticketSide, 'ui.keyStyle': ui.keyStyle, 'till.autoLockSeconds': autoLock, 'day.cutoverHour': cutover })
  }

  const langOptions = (['fr', 'ar', 'en'] as const).map((lang) => ({ value: lang, label: t(`lang.${lang}`) }))
  const rates = (values?.['vat.rates'] as number[] | undefined) ?? []

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.settings')} />
      <Tabs
        variant="segmented"
        value={tab}
        onChange={setTab}
        aria-label={t('bo.nav.settings')}
        tabs={[
          { id: 'business', label: t('bo.settings.business') },
          { id: 'receipt', label: t('bo.settings.receipt') },
          { id: 'vat', label: t('bo.settings.vat') },
          { id: 'ui', label: t('bo.settings.ui') }
        ]}
      />

      {tab === 'business' && (
        <Card className="bo-form">
          <p className="muted">{t('bo.settings.legalHint')}</p>
          <div className="bo-grid-2">
            {LEGAL_FIELDS.map((key) => (
              <TextField key={key} label={t(`bo.settings.legal.${key}`)} value={legal[key]} onChange={(value) => setLegal({ ...legal, [key]: value })} error={errors[key]} inputMode={key === 'ice' ? 'numeric' : undefined} data-testid={`legal-${key}`} />
            ))}
          </div>
          <div className="bo-form__actions">
            <Button size="lg" onClick={saveLegal} data-testid="settings-save-business">
              {t('common.save')}
            </Button>
          </div>
        </Card>
      )}

      {tab === 'receipt' && (
        <div className="bo-split">
          <Card className="bo-form">
            <Select label={t('bo.settings.receiptLang')} value={receipt.lang} onChange={(lang) => setReceipt({ ...receipt, lang })} options={langOptions} />
            <TextField label={t('bo.settings.receiptHeader')} value={receipt.header} onChange={(header) => setReceipt({ ...receipt, header })} data-testid="receipt-header" />
            <TextField label={t('bo.settings.receiptFooter')} value={receipt.footer} onChange={(footer) => setReceipt({ ...receipt, footer })} data-testid="receipt-footer" />
            <div className="bo-form__actions">
              <Button size="lg" onClick={() => void save({ 'receipt.lang': receipt.lang, 'receipt.header': receipt.header, 'receipt.footer': receipt.footer })} data-testid="settings-save-receipt">
                {t('common.save')}
              </Button>
            </div>
          </Card>
          <ReceiptPreview legal={legal} header={receipt.header} footer={receipt.footer} lang={receipt.lang} />
        </div>
      )}

      {tab === 'vat' && (
        <Card className="bo-form">
          <p className="muted">{t('bo.settings.vatHint')}</p>
          <ul className="bo-list" data-testid="vat-rates">
            {rates.map((bp) => (
              <li key={bp}>
                <span>{f.vat(bp)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === 'ui' && (
        <Card className="bo-form">
          <Select label={t('bo.settings.defaultLang')} value={ui.defaultLang} onChange={(defaultLang) => setUi({ ...ui, defaultLang })} options={langOptions} />
          <Select
            label={t('bo.settings.ticketSide')}
            value={ui.ticketSide}
            onChange={(ticketSide) => setUi({ ...ui, ticketSide })}
            options={[
              { value: 'start', label: t('bo.settings.sideStart') },
              { value: 'end', label: t('bo.settings.sideEnd') }
            ]}
          />
          <Select
            label={t('bo.settings.keyStyle')}
            value={ui.keyStyle}
            onChange={(keyStyle) => setUi({ ...ui, keyStyle })}
            options={[
              { value: 'color', label: t('bo.settings.keyColor') },
              { value: 'photo', label: t('bo.settings.keyPhoto') }
            ]}
          />
          <TextField label={t('bo.settings.autoLock')} inputMode="numeric" value={ui.autoLock} onChange={(autoLock) => setUi({ ...ui, autoLock })} error={errors['autoLock']} hint={t('bo.settings.autoLockHint')} />
          <TextField label={t('bo.settings.cutover')} inputMode="numeric" value={ui.cutover} onChange={(cutover) => setUi({ ...ui, cutover })} error={errors['cutover']} hint={t('bo.settings.cutoverHint')} />
          <div className="bo-form__actions">
            <Button size="lg" onClick={saveUi} data-testid="settings-save-ui">
              {t('common.save')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
