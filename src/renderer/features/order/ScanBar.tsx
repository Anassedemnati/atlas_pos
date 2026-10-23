import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseMoney } from '@shared/money'
import { invoke } from '../../app/api'
import { Button, Icon, Modal, Select, TextField, useToast } from '../../ui'
import { errorMessage } from '../../app/api'
import { useFormat } from '../till/format'
import { can, loadTillData, useTill } from '../till/store'

export interface ScanBarProps {
  /** A barcode was read: a known product is added by the pad, an unknown one returns false. */
  onScan: (barcode: string) => boolean | Promise<boolean>
  /** A product was created from an unknown barcode: add it. */
  onCreated: (productId: string) => void
}

/**
 * The retail scan field. A keyboard-wedge scanner types the barcode and Enter, so this input keeps the focus
 * (unless a dialog is open). It is a plain input: the on-screen keyboard must not open for it.
 */
export function ScanBar({ onScan, onCreated }: ScanBarProps) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focus = () => {
      if (document.querySelector('.modal-backdrop')) return
      const active = document.activeElement as HTMLElement | null
      if (active && active !== input.current && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return
      input.current?.focus()
    }
    focus()
    const timer = setInterval(focus, 800)
    return () => clearInterval(timer)
  }, [])

  const submit = async () => {
    const barcode = code.trim()
    setCode('')
    if (!barcode) return
    const found = await onScan(barcode)
    if (!found) setUnknown(barcode)
  }

  return (
    <div className="scanbar">
      <Icon name="barcode" size={30} />
      <input
        ref={input}
        className="scanbar__input"
        inputMode="none"
        autoFocus
        autoComplete="off"
        value={code}
        placeholder={t('order.scanPlaceholder')}
        aria-label={t('order.scan')}
        data-testid="scan-input"
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
        }}
      />
      {unknown && <QuickCreate barcode={unknown} onClose={() => setUnknown(null)} onCreated={(id) => { setUnknown(null); onCreated(id) }} />}
    </div>
  )
}

/** An unknown barcode: a manager gives it a name, a price and a category so the sale can go on. */
function QuickCreate({ barcode, onClose, onCreated }: { barcode: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const data = useTill()
  const { name } = useFormat()
  const allowed = can(data, 'catalog.manage')
  const [label, setLabel] = useState('')
  const [price, setPrice] = useState('')
  const [category, setCategory] = useState<string | null>(data.catalog.categories[0]?.id ?? null)
  const cents = parseMoney(price)
  const ready = label.trim() !== '' && cents !== null && cents > 0 && category !== null

  const create = async () => {
    if (!ready || cents === null || category === null) return
    const result = await invoke('catalog.quickCreateProduct', { barcode, name: label.trim(), priceCents: cents, categoryId: category })
    if (!result.ok) return void toast.error(errorMessage(result.error))
    await loadTillData()
    onCreated(result.value.id)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('order.unknownBarcode', { barcode })}
      size="md"
      footer={
        allowed ? (
          <Button size="lg" block disabled={!ready} onClick={() => void create()} data-testid="quick-confirm">
            {t('order.createProduct')}
          </Button>
        ) : undefined
      }
    >
      <div className="stack" data-testid="quick-create">
        {allowed ? (
          <>
            <TextField label={t('order.productName')} value={label} onChange={setLabel} maxLength={100} autoFocus data-testid="quick-name" />
            <TextField label={t('order.productPrice')} value={price} onChange={setPrice} inputMode="decimal" data-testid="quick-price" />
            <Select
              label={t('order.productCategory')}
              value={category}
              options={data.catalog.categories.map((c) => ({ value: c.id, label: name(c.name) }))}
              onChange={setCategory}
            />
          </>
        ) : (
          <p className="warn-text">{t('order.needManagerForProduct')}</p>
        )}
      </div>
    </Modal>
  )
}
