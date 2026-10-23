import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PRINTER_KINDS, PRINTER_ROLES, type PrinterDraft } from '@shared/setup/draft'
import { Button, Modal, Select, TextField, Toggle } from '../../../ui'
import { Chip } from './Chip'

type Kind = PrinterDraft['kind']

const split = (address: string, separator: string): [string, string] => {
  const cut = address.lastIndexOf(separator)
  return cut < 0 ? [address, ''] : [address.slice(0, cut), address.slice(cut + 1)]
}

/** The address a kind needs, from the form's pieces (`host:port`, `path@baud`, or a plain name). */
function addressOf(kind: Kind, parts: { host: string; port: string; path: string; baud: string; plain: string }): string {
  if (kind === 'virtual') return ''
  if (kind === 'network') return `${parts.host.trim()}:${parts.port.trim() || '9100'}`
  if (kind === 'serial') return parts.baud.trim() ? `${parts.path.trim()}@${parts.baud.trim()}` : parts.path.trim()
  return parts.plain.trim()
}

export interface PrinterEditorProps {
  /** The printer to edit, or a new one (its `tempId` is fresh). */
  printer: PrinterDraft
  isNew: boolean
  onSave: (printer: PrinterDraft) => void
  onClose: () => void
}

/** Add or change one printer: how it is reached, what it prints, the paper width. */
export function PrinterEditor({ printer, isNew, onSave, onClose }: PrinterEditorProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<Kind>(printer.kind)
  const [name, setName] = useState(printer.name)
  const [role, setRole] = useState(printer.role)
  const [widthMm, setWidthMm] = useState(printer.widthMm)
  const [raster, setRaster] = useState(printer.raster)
  const [host, setHost] = useState(printer.kind === 'network' ? split(printer.address, ':')[0] : '')
  const [port, setPort] = useState(printer.kind === 'network' ? split(printer.address, ':')[1] : '9100')
  const [path, setPath] = useState(printer.kind === 'serial' ? split(printer.address, '@')[0] : '')
  const [baud, setBaud] = useState(printer.kind === 'serial' ? split(printer.address, '@')[1] : '')
  const [plain, setPlain] = useState(printer.kind === 'device-file' || printer.kind === 'windows-raw' || printer.kind === 'os-html' ? printer.address : '')

  const save = () =>
    onSave({
      ...printer,
      kind,
      name: name.trim() || t(`setupWizard.hardware.defaultName.${role}`),
      role,
      widthMm,
      raster,
      address: addressOf(kind, { host, port, path, baud, plain })
    })

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={isNew ? t('setupWizard.hardware.addPrinter') : t('setupWizard.hardware.editPrinter')}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" onClick={save} data-testid="printer-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Select
          label={t('setupWizard.hardware.kind')}
          value={kind}
          onChange={setKind}
          options={PRINTER_KINDS.map((value) => ({ value, label: t(`setupWizard.hardware.kinds.${value}`) }))}
        />
        <TextField label={t('setupWizard.hardware.name')} value={name} onChange={setName} placeholder={t(`setupWizard.hardware.defaultName.${role}`)} maxLength={100} />
        {kind === 'network' && (
          <div className="wiz-form">
            <TextField label={t('setupWizard.hardware.host')} value={host} onChange={setHost} placeholder="192.168.1.50" inputMode="decimal" />
            <TextField label={t('setupWizard.hardware.port')} value={port} onChange={(value) => setPort(value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" />
          </div>
        )}
        {kind === 'serial' && (
          <div className="wiz-form">
            <TextField label={t('setupWizard.hardware.serialPath')} value={path} onChange={setPath} placeholder="COM3" />
            <TextField label={t('setupWizard.hardware.baud')} value={baud} onChange={(value) => setBaud(value.replace(/\D/g, '').slice(0, 6))} placeholder="9600" inputMode="numeric" />
          </div>
        )}
        {(kind === 'device-file' || kind === 'windows-raw' || kind === 'os-html') && (
          <TextField label={t(`setupWizard.hardware.address.${kind}`)} value={plain} onChange={setPlain} />
        )}
        {kind === 'virtual' && <p className="muted">{t('setupWizard.hardware.virtualHint')}</p>}
        <div className="field">
          <span className="field__label">{t('setupWizard.hardware.role')}</span>
          <div className="cluster" role="group" aria-label={t('setupWizard.hardware.role')}>
            {PRINTER_ROLES.map((value) => (
              <Chip key={value} selected={role === value} onClick={() => setRole(value)}>
                {t(`setupWizard.hardware.roles.${value}`)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field__label">{t('setupWizard.hardware.width')}</span>
          <div className="cluster" role="group" aria-label={t('setupWizard.hardware.width')}>
            {([80, 58] as const).map((value) => (
              <Chip key={value} selected={widthMm === value} onClick={() => setWidthMm(value)}>
                {value} mm
              </Chip>
            ))}
          </div>
        </div>
        {kind !== 'virtual' && kind !== 'os-html' && <Toggle label={t('setupWizard.hardware.raster')} checked={raster} onChange={setRaster} />}
      </div>
    </Modal>
  )
}
