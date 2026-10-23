import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiscountDto } from '@shared/dto'
import { parseMoney } from '@shared/money'
import { Button, Keypad, Modal, ReasonPicker, Tabs } from '../../ui'
import { useFormat } from '../till/format'
import { setting, useTill } from '../till/store'

export interface DiscountDialogProps {
  /** Shown in the title: the ticket or the line. */
  title: string
  current: DiscountDto | null
  onCancel: () => void
  /** `null` takes the discount off. */
  onApply: (discount: DiscountDto | null) => void
}

const QUICK = [5, 10, 15, 20]

/** A discount in % or in DH, with a reason (from the business's list). The limit is checked by the main process. */
export function DiscountDialog({ title, current, onCancel, onApply }: DiscountDialogProps) {
  const { t } = useTranslation()
  const data = useTill()
  const { money } = useFormat()
  const [mode, setMode] = useState<'pct' | 'amount'>(current?.kind ?? 'pct')
  const [text, setText] = useState('')
  const [asking, setAsking] = useState(false)
  // 12,50 % is 1250 bp and 12,50 DH is 1250 cents: both read the typed text as hundredths.
  const value = parseMoney(text)
  const valid = value !== null && value > 0 && (mode === 'amount' || value <= 10000)
  const reasons = setting<string[]>(data, 'discount.reasons', []).map((label) => ({ id: label, label }))

  return (
    <>
      <Modal open={!asking} onClose={onCancel} title={title} size="md">
        <div className="stack" style={{ alignItems: 'center' }} data-testid="discount-dialog">
          <Tabs
            tabs={[
              { id: 'pct', label: '%' },
              { id: 'amount', label: 'DH' }
            ]}
            value={mode}
            onChange={(id) => {
              setMode(id as 'pct' | 'amount')
              setText('')
            }}
          />
          {mode === 'pct' && (
            <div className="cluster">
              {QUICK.map((pct) => (
                <Button key={pct} variant={text === String(pct) ? 'primary' : 'secondary'} onClick={() => setText(String(pct))} data-testid={`discount-${pct}`}>
                  {pct} %
                </Button>
              ))}
            </div>
          )}
          <Keypad mode="money" value={text} onChange={setText} onEnter={() => valid && setAsking(true)} enterLabel={t('order.discountApply')} captureKeys />
          {valid && <p className="muted">{mode === 'pct' ? `${text} %` : money(value ?? 0)}</p>}
          {current && (
            <Button variant="danger" onClick={() => onApply(null)} data-testid="discount-remove">
              {t('order.discountRemove')}
            </Button>
          )}
        </div>
      </Modal>
      <ReasonPicker
        open={asking}
        title={t('order.discountReason')}
        reasons={reasons.length > 0 ? reasons : undefined}
        kind="discount"
        onCancel={() => setAsking(false)}
        onPick={(reason) => {
          setAsking(false)
          if (value === null) return
          onApply(mode === 'pct' ? { kind: 'pct', bp: value, reason } : { kind: 'amount', cents: value, reason })
        }}
      />
    </>
  )
}
