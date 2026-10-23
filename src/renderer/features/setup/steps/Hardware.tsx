import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HardwareDto } from '@shared/dto'
import { pickName } from '@shared/names'
import type { PrinterDraft } from '@shared/setup/draft'
import { errorMessage } from '../../../app/api'
import { currentLanguage } from '../../../app/i18n'
import { Button, Icon, Pill, TextField, Toggle, useToast } from '../../../ui'
import { Chip } from '../components/Chip'
import { PrinterEditor } from '../components/PrinterEditor'
import { Section } from '../components/Section'
import { useWizard } from '../wizard-context'

type Test = 'ok' | 'failed'

const newPrinter = (seed: Partial<PrinterDraft>, language: PrinterDraft['lang']): PrinterDraft => ({
  tempId: crypto.randomUUID(),
  name: '',
  kind: 'network',
  address: '',
  widthMm: 80,
  lang: language,
  raster: false,
  role: 'receipt',
  active: true,
  ...seed
})

/** Step 4: printers (detect, add, test), the cash drawer, routing of categories, customer display. */
export function Hardware() {
  const { t } = useTranslation()
  const toast = useToast()
  const { draft, templates, profile, edit, api, errors } = useWizard()
  const [hardware, setHardware] = useState<HardwareDto | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [editing, setEditing] = useState<{ printer: PrinterDraft; isNew: boolean } | null>(null)
  const [tests, setTests] = useState<Record<string, Test>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [scan, setScan] = useState('')
  const [scanned, setScanned] = useState('')

  const detect = useCallback(async () => {
    setDetecting(true)
    const result = await api.call('setup.detectHardware', {}, { silent: true })
    if (result.ok) setHardware(result.value)
    setDetecting(false)
  }, [api])

  useEffect(() => {
    void detect()
  }, [detect])

  const printers = draft.printers
  const isWindows = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)

  const runTest = async (printer: PrinterDraft, action: 'page' | 'drawer') => {
    setTesting(`${printer.tempId}:${action}`)
    const result = await api.call('setup.testPrinter', { printer, action }, { silent: true })
    setTesting(null)
    setTests((previous) => ({ ...previous, [printer.tempId]: result.ok ? 'ok' : 'failed' }))
    if (result.ok) toast.success(t(action === 'drawer' ? 'setupWizard.hardware.drawerSent' : 'setupWizard.hardware.pageSent'))
    else toast.error(errorMessage(result.error))
  }

  const savePrinter = (printer: PrinterDraft, isNew: boolean) => {
    edit((state) => ({ printers: isNew ? [...state.printers, printer] : state.printers.map((item) => (item.tempId === printer.tempId ? printer : item)) }))
    setTests((previous) => {
      const { [printer.tempId]: _dropped, ...rest } = previous
      return rest
    })
    setEditing(null)
  }

  const removePrinter = (printer: PrinterDraft) =>
    edit((state) => ({
      printers: state.printers.filter((item) => item.tempId !== printer.tempId),
      routing: Object.fromEntries(Object.entries(state.routing).map(([code, ids]) => [code, ids.filter((id) => id !== printer.tempId)]))
    }))

  const template = templates.find((item) => item.id === draft.businessType)
  const categories: { code: string; name: string; route: 'kitchen' | 'bar' | null }[] =
    draft.catalogSource === 'template' && template
      ? template.categories.map((category) => ({ code: category.code, name: pickName(category.name, currentLanguage()), route: category.route }))
      : draft.catalogSource === 'profile' && profile
        ? profile.categories.map((category) => ({ code: category.code, name: pickName(category.name, currentLanguage()), route: null }))
        : []

  const toggleRoute = (code: string, tempId: string) =>
    edit((state) => {
      const current = state.routing[code] ?? []
      return { routing: { ...state.routing, [code]: current.includes(tempId) ? current.filter((id) => id !== tempId) : [...current, tempId] } }
    })

  const detected: { key: string; label: string; seed: Partial<PrinterDraft> }[] = hardware
    ? [
        ...hardware.osPrinters.map((printer) => ({
          key: `os:${printer.name}`,
          label: printer.name,
          seed: { kind: isWindows ? ('windows-raw' as const) : ('os-html' as const), address: printer.name, name: printer.name }
        })),
        ...hardware.serialPorts.map((port) => ({
          key: `serial:${port.path}`,
          label: port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path,
          seed: { kind: 'serial' as const, address: port.path, name: port.manufacturer ?? port.path }
        })),
        ...hardware.deviceFiles.map((file) => ({ key: `file:${file}`, label: file, seed: { kind: 'device-file' as const, address: file, name: file } }))
      ]
    : []
  const known = new Set(printers.map((printer) => printer.address))

  return (
    <div className="stack wiz-stack">
      <Section
        title={t('setupWizard.hardware.printers')}
        end={
          <div className="cluster">
            <Button variant="ghost" icon="plus" onClick={() => setEditing({ printer: newPrinter({ kind: 'network', address: '' }, draft.lang.receipt), isNew: true })} data-testid="add-network">
              {t('setupWizard.hardware.addNetwork')}
            </Button>
            <Button
              variant="ghost"
              icon="printer"
              onClick={() => savePrinter(newPrinter({ kind: 'virtual', name: t('setupWizard.hardware.virtualName') }, draft.lang.receipt), true)}
              data-testid="add-virtual"
            >
              {t('setupWizard.hardware.addVirtual')}
            </Button>
          </div>
        }
      >
        {printers.length === 0 ? (
          <p className="muted">{t('setupWizard.hardware.noPrinter')}</p>
        ) : (
          <ul className="wiz-devices">
            {printers.map((printer, index) => (
              <li key={printer.tempId} className="wiz-device" data-testid="printer-row">
                <Icon name="printer" size={36} />
                <div className="wiz-device__main">
                  <strong>{printer.name || t(`setupWizard.hardware.defaultName.${printer.role}`)}</strong>
                  <span className="muted">
                    {t(`setupWizard.hardware.kinds.${printer.kind}`)}
                    {printer.address ? ` · ${printer.address}` : ''} · {printer.widthMm} mm
                  </span>
                  {(errors[`printers.${index}.address`] || errors[`printers.${index}.name`]) && (
                    <span className="field__message field__message--error">{errors[`printers.${index}.address`] ?? errors[`printers.${index}.name`]}</span>
                  )}
                </div>
                <div className="wiz-device__status">
                  <Pill tone="info">{t(`setupWizard.hardware.roles.${printer.role}`)}</Pill>
                  {tests[printer.tempId] === 'ok' && <Pill tone="success" dot>{t('setupWizard.hardware.testOk')}</Pill>}
                  {tests[printer.tempId] === 'failed' && <Pill tone="danger" dot>{t('setupWizard.hardware.testFailed')}</Pill>}
                </div>
                <div className="wiz-device__actions">
                <Button variant="ghost" onClick={() => void runTest(printer, 'page')} disabled={testing !== null} data-testid="printer-test">
                  {testing === `${printer.tempId}:page` ? t('common.loading') : t('setupWizard.hardware.testPage')}
                </Button>
                {printer.role === 'receipt' && (
                  <Button variant="ghost" icon="drawer" onClick={() => void runTest(printer, 'drawer')} disabled={testing !== null} data-testid="printer-drawer">
                    {t('setupWizard.hardware.testDrawer')}
                  </Button>
                )}
                <Button variant="secondary" icon="gear" aria-label={t('common.edit')} onClick={() => setEditing({ printer, isNew: false })} />
                <Button variant="secondary" icon="trash" aria-label={t('common.remove')} onClick={() => removePrinter(printer)} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="wiz-detect">
          <div className="wiz-detect__head">
            <h3 className="h3">{t('setupWizard.hardware.detected')}</h3>
            <Button variant="ghost" onClick={() => void detect()} disabled={detecting}>
              {detecting ? t('setupWizard.hardware.detecting') : t('setupWizard.hardware.detectAgain')}
            </Button>
          </div>
          {hardware && detected.length === 0 && <p className="muted">{t('setupWizard.hardware.nothingDetected')}</p>}
          <div className="cluster">
            {detected.map((item) => (
              <Button
                key={item.key}
                variant="secondary"
                icon="plus"
                disabled={known.has(item.seed.address ?? '')}
                onClick={() => setEditing({ printer: newPrinter(item.seed, draft.lang.receipt), isNew: true })}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      {categories.length > 0 && (
        <Section title={t('setupWizard.hardware.routing')} hint={t('setupWizard.hardware.routingHint')}>
          {printers.length === 0 ? (
            <p className="muted">{t('setupWizard.hardware.routingNone')}</p>
          ) : (
            <ul className="wiz-routing">
              {categories.map((category) => {
                const chosen = draft.routing[category.code] ?? []
                return (
                  <li key={category.code} className="wiz-routing__row">
                    <div className="wiz-routing__name">
                      <strong>{category.name}</strong>
                      {chosen.length === 0 && (
                        <span className="muted">{category.route ? t('setupWizard.hardware.routingDefault', { role: t(`setupWizard.hardware.roles.${category.route}`) }) : t('setupWizard.hardware.routingNoDefault')}</span>
                      )}
                    </div>
                    <div className="cluster">
                      {printers.map((printer) => (
                        <Chip key={printer.tempId} selected={chosen.includes(printer.tempId)} onClick={() => toggleRoute(category.code, printer.tempId)}>
                          {printer.name || t(`setupWizard.hardware.defaultName.${printer.role}`)}
                        </Chip>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}

      <Section title={t('setupWizard.hardware.peripherals')}>
        <div className="stack">
          <div className="wiz-row">
            <Toggle className="grow" icon="display" label={t('setupWizard.hardware.customerDisplay')} checked={draft.customerDisplay} onChange={(checked) => edit({ customerDisplay: checked })} />
            <Pill tone={(hardware?.displays.length ?? 0) > 1 ? 'success' : 'warning'} dot>
              {(hardware?.displays.length ?? 0) > 1 ? t('setupWizard.hardware.secondScreen') : t('setupWizard.hardware.noSecondScreen')}
            </Pill>
          </div>
          <div className="wiz-row">
            <TextField
              className="grow"
              label={t('setupWizard.hardware.scanner')}
              hint={t('setupWizard.hardware.scannerHint')}
              value={scan}
              onChange={(value) => {
                setScan(value)
                setScanned('')
              }}
              onEnter={() => {
                if (scan.trim()) setScanned(scan.trim())
                setScan('')
              }}
              icon="barcode"
            />
            {scanned && (
              <Pill tone="success" icon="check">
                {t('setupWizard.hardware.scanned', { code: scanned })}
              </Pill>
            )}
          </div>
        </div>
      </Section>

      {editing && <PrinterEditor printer={editing.printer} isNew={editing.isNew} onSave={(printer) => savePrinter(printer, editing.isNew)} onClose={() => setEditing(null)} />}
    </div>
  )
}
