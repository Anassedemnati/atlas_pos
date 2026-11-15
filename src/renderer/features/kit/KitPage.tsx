import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGS, setLanguage, type Lang } from '../../app/i18n'
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ICON_NAMES,
  Icon,
  Keypad,
  KEY_BACKSPACE,
  OnScreenKeyboard,
  Pill,
  ReasonPicker,
  Select,
  Stepper,
  Tabs,
  TextField,
  Toggle,
  TopBar,
  useToast,
  type KeyboardLayout
} from '../../ui'
import './kit.css'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="kit__section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function KitPage() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const [name, setName] = useState('')
  const [printer, setPrinter] = useState<string | null>('usb')
  const [modules, setModules] = useState({ floor: true, kitchen: true, stock: false })
  const [step, setStep] = useState(1)
  const [tab, setTab] = useState('plats')
  const [business, setBusiness] = useState('restaurant')
  const [pin, setPin] = useState<string | null>(null)
  const [layout, setLayout] = useState<KeyboardLayout>('azerty')
  const [typed, setTyped] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [reason, setReason] = useState(false)

  const steps = t('kit.steps').split('|')
  const tabs = t('kit.tabs')
    .split('|')
    .map((label, index) => ({ id: ['entrees', 'plats', 'grillades', 'desserts', 'boissons'][index]!, label, color: ['#8793a8', '#0fa3a3', '#f2a541', '#a78bfa', '#4f9cf9'][index]! }))

  return (
    <div className="page kit">
      <TopBar title={t('kit.title')} user={{ name: 'Karim' }} clock backupStatus="ok">
        <Tabs variant="bar" tabs={LANGS.map((id) => ({ id, label: t(`lang.${id}`) }))} value={i18n.language as Lang} onChange={(id) => void setLanguage(id)} aria-label={t('common.language')} />
      </TopBar>
      <div className="page__body kit__body">
        <Section title={t('kit.buttons')}>
          <div className="cluster">
            <Button size="md">{t('common.save')}</Button>
            <Button size="lg" iconEnd="next">
              {t('common.next')}
            </Button>
            <Button size="xl" icon="cart">
              {t('common.confirm')}
            </Button>
            <Button variant="secondary" icon="back">
              {t('common.back')}
            </Button>
            <Button variant="ghost">{t('common.test')}</Button>
            <Button variant="danger" icon="trash">
              {t('common.delete')}
            </Button>
            <Button disabled>{t('common.save')}</Button>
          </div>
        </Section>

        <Section title={t('kit.fields')}>
          <div className="kit__grid">
            <TextField label={t('kit.sampleLabel')} value={name} onChange={setName} placeholder={t('kit.sampleName')} hint={t('common.optional')} />
            <TextField label={t('common.search')} value="" onChange={() => {}} icon="search" hideLabel placeholder={t('common.search')} />
            <TextField label={t('kit.sampleLabel')} value={t('kit.sampleName')} onChange={() => {}} error={t('errors.invalid_input')} />
            <Select
              label={t('kit.sampleSelect')}
              value={printer}
              onChange={setPrinter}
              options={[
                { value: 'usb', label: t('kit.samplePrinter1') },
                { value: 'net', label: t('kit.samplePrinter2') }
              ]}
            />
          </div>
          <div className="kit__grid">
            <Toggle icon="table" label={t('kit.restaurant')} checked={modules.floor} onChange={(floor) => setModules({ ...modules, floor })} />
            <Toggle icon="utensils" label={t('kit.cafe')} checked={modules.kitchen} onChange={(kitchen) => setModules({ ...modules, kitchen })} />
            <Toggle icon="barcode" label={t('kit.stock')} checked={modules.stock} onChange={(stock) => setModules({ ...modules, stock })} />
          </div>
        </Section>

        <Section title={t('kit.layout')}>
          <div className="kit__wizard">
            <Stepper steps={steps} current={step} />
            <div className="stack">
              <div className="kit__grid kit__grid--cards">
                {(
                  [
                    ['restaurant', 'utensils'],
                    ['cafe', 'coffee'],
                    ['bakery', 'bread'],
                    ['retail', 'store']
                  ] as const
                ).map(([id, icon]) => (
                  <Card key={id} selected={business === id} onClick={() => setBusiness(id)}>
                    <Icon name={icon} size={48} />
                    {t(`kit.${id}`)}
                  </Card>
                ))}
              </div>
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
              <Tabs variant="underline" tabs={tabs.map(({ id, label }) => ({ id, label }))} value={tab} onChange={setTab} />
              <div className="cluster">
                <Button variant="secondary" icon="back" onClick={() => setStep(Math.max(0, step - 1))}>
                  {t('common.back')}
                </Button>
                <Button iconEnd="next" onClick={() => setStep(Math.min(steps.length - 1, step + 1))}>
                  {t('common.next')}
                </Button>
              </div>
            </div>
          </div>
        </Section>

        <Section title={t('kit.keypad')}>
          <div className="kit__pads">
            <Keypad mode="pin" onEnter={(value) => setPin(value)} invalid={pin === '0000'} />
            <Keypad mode="qty" />
            <Keypad mode="money" />
            {pin && <Pill tone="teal">{`PIN ${'•'.repeat(pin.length)}`}</Pill>}
          </div>
        </Section>

        <Section title={t('kit.keyboard')}>
          <div className="stack">
            <Tabs tabs={(['azerty', 'qwerty', 'arabic'] as const).map((id) => ({ id, label: id }))} value={layout} onChange={setLayout} />
            <TextField label={t('kit.sampleLabel')} value={typed} onChange={setTyped} till={false} />
            <OnScreenKeyboard
              layout={layout}
              onKey={(key) => setTyped((value) => (key === KEY_BACKSPACE ? value.slice(0, -1) : key === 'Enter' ? value : value + key))}
            />
          </div>
        </Section>

        <Section title={t('kit.feedback')}>
          <div className="cluster">
            <Pill tone="success" dot>
              {t('status.backup.ok')}
            </Pill>
            <Pill tone="warning" dot>
              {t('status.backup.warning')}
            </Pill>
            <Pill tone="danger" icon="warning">
              {t('status.printer.error')}
            </Pill>
            <Pill tone="info">{t('common.optional')}</Pill>
            <Pill tone="neutral" dot>
              {t('common.disabled')}
            </Pill>
          </div>
          <div className="cluster">
            <Button variant="secondary" onClick={() => toast.info(t('kit.toastInfo'))}>
              {t('kit.toastInfo')}
            </Button>
            <Button variant="secondary" onClick={() => toast.error(t('kit.toastError'))}>
              {t('kit.toastError')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              {t('kit.openConfirm')}
            </Button>
            <Button variant="ghost" onClick={() => setReason(true)}>
              {t('kit.openReason')}
            </Button>
          </div>
          <Card>
            <EmptyState icon="table" title={t('common.noResults')} hint={t('routes.placeholder')} />
          </Card>
        </Section>

        <Section title={t('kit.icons')}>
          <div className="kit__icons">
            {ICON_NAMES.map((icon) => (
              <div key={icon} className="kit__icon">
                <Icon name={icon} size={32} />
                <span>{icon}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={t('kit.confirmTitle')}
        message={t('kit.confirmMessage')}
        confirmLabel={t('common.delete')}
        onConfirm={() => setConfirm(false)}
        onCancel={() => setConfirm(false)}
      />
      <ReasonPicker
        open={reason}
        onPick={(text) => {
          setReason(false)
          toast.success(text)
        }}
        onCancel={() => setReason(false)}
      />
    </div>
  )
}
