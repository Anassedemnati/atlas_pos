import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto } from '@shared/dto'
import { invoke } from '../../app/api'
import { Button, Icon, Modal, useToast } from '../../ui'
import { cx } from '../../ui/metrics'
import { firstToken, useGuard } from '../till/Override'
import { formatQty, useFormat } from '../till/format'
import { useTill } from '../till/store'

export interface SplitDialogProps {
  order: OrderDto
  onClose: () => void
  /** The bill part was paid and closed: the order shown must be read again. */
  onSplit: () => void
}

/** Bill by items: tick the lines one guest pays, pick the method, and that part is paid and closed on its own ticket. */
export function SplitDialog({ order, onClose, onSplit }: SplitDialogProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { guard } = useGuard()
  const { methods } = useTill()
  const { money, name } = useFormat()
  const lines = order.lines.filter((l) => l.status === 'active')
  const [chosen, setChosen] = useState<string[]>([])
  const total = lines.filter((l) => chosen.includes(l.id)).reduce((sum, l) => sum + l.netCents, 0)
  const toggle = (id: string) => setChosen((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]))

  const pay = async (methodCode: string) => {
    const result = await guard((tokens) =>
      invoke('orders.splitAndClose', {
        orderId: order.id,
        groups: [{ lineIds: chosen, payments: [{ methodCode, amountCents: total, tenderedCents: total }] }],
        overrideTokenId: firstToken(tokens)
      })
    )
    if (result.ok) {
      toast.success(t('order.splitDone', { label: result.value[0]?.label ?? '' }))
      onSplit()
    }
  }

  return (
    <Modal open onClose={onClose} title={t('order.split')} size="md">
      <div className="stack" data-testid="split-dialog">
        <p className="muted">{t('order.splitHint')}</p>
        <ul className="plain-list">
          {lines.map((line) => (
            <li key={line.id}>
              <button type="button" className={cx('split-row', chosen.includes(line.id) && 'split-row--on')} onClick={() => toggle(line.id)} aria-pressed={chosen.includes(line.id)}>
                <span className="split-row__check">{chosen.includes(line.id) && <Icon name="check" size={22} strokeWidth={3} />}</span>
                <span className="grow">
                  {formatQty(line.qtyMilli)} × {name(line.name)}
                </span>
                <strong className="figure">{money(line.netCents)}</strong>
              </button>
            </li>
          ))}
        </ul>
        <p className="h2 figure" data-testid="split-total">
          {money(total)}
        </p>
        <div className="cluster">
          {methods
            .filter((m) => m.active)
            .map((method) => (
              <Button key={method.id} size="lg" disabled={chosen.length === 0 || chosen.length === lines.length} onClick={() => void pay(method.code)}>
                {name(method.name)}
              </Button>
            ))}
        </div>
        {chosen.length === lines.length && lines.length > 0 && <p className="muted">{t('order.splitAll')}</p>}
      </div>
    </Modal>
  )
}
