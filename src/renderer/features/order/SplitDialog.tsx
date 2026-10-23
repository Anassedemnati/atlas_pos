import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto } from '@shared/dto'
import { equalShares } from '@shared/split'
import { invoke, useApi } from '../../app/api'
import { Button, Icon, Modal, Tabs, useToast } from '../../ui'
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

/**
 * Divide the bill: by items (tick the lines one guest pays: that part is paid and closed on its own ticket) or in
 * equal parts (the parts are paid one after the other on the same order, which closes with the last).
 */
export function SplitDialog({ order, onClose, onSplit }: SplitDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'items' | 'equal'>(order.lines.filter((l) => l.status === 'active').length < 2 ? 'equal' : 'items')
  const tabs = [
    ...(order.lines.filter((l) => l.status === 'active').length >= 2 ? [{ id: 'items', label: t('order.splitByItems') }] : []),
    { id: 'equal', label: t('order.splitEqual') }
  ]
  return (
    <Modal open onClose={onClose} title={t('order.split')} size="md">
      <div className="stack">
        {tabs.length > 1 && <Tabs tabs={tabs} value={mode} onChange={(id) => setMode(id as 'items' | 'equal')} aria-label={t('order.split')} />}
        {mode === 'items' ? <ByItems order={order} onSplit={onSplit} /> : <EqualParts order={order} onSplit={onSplit} />}
      </div>
    </Modal>
  )
}

const PART_COUNTS = [2, 3, 4, 5, 6, 7, 8]

/** Equal parts: N sequential partial payments of what is due (the odd centimes on the first parts), then the order closes. */
function EqualParts({ order: initial, onSplit }: { order: OrderDto; onSplit: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const { guard } = useGuard()
  const { methods } = useTill()
  const { money, name } = useFormat()
  const [order, setOrder] = useState(initial)
  const [parts, setParts] = useState<number | null>(null)
  const [paid, setPaid] = useState(0)
  const [busy, setBusy] = useState(false)

  if (parts === null) {
    return (
      <div className="stack" data-testid="equal-split">
        <p className="muted">{t('order.equalHint', { amount: money(order.dueCents) })}</p>
        <div className="cluster">
          {PART_COUNTS.map((count) => (
            <Button key={count} variant="secondary" size="lg" disabled={order.dueCents < count} onClick={() => setParts(count)} data-testid={`equal-${count}`}>
              {count}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  // Each step shares what is still due among the parts still to pay: the last part is exactly what is left.
  const amount = equalShares(order.dueCents, parts - paid)[0] ?? 0

  const pay = async (methodCode: string) => {
    if (busy) return
    setBusy(true)
    const result = await api.call('orders.addPayment', { orderId: order.id, payment: { methodCode, amountCents: amount, tenderedCents: amount } })
    if (!result.ok) return void setBusy(false)
    setOrder(result.value)
    if (paid + 1 < parts) {
      setPaid(paid + 1)
      return void setBusy(false)
    }
    const closed = await guard((tokens) => invoke('orders.close', { orderId: order.id, overrideTokenId: firstToken(tokens) }))
    setBusy(false)
    if (closed.ok) {
      toast.success(t('order.splitDone', { label: closed.value.label }))
      onSplit()
    }
  }

  return (
    <div className="stack" data-testid="equal-split">
      <p className="h2 figure" data-testid="equal-part">
        {t('order.equalPart', { n: paid + 1, total: parts, amount: money(amount) })}
      </p>
      <p className="muted">{t('order.equalDue', { amount: money(order.dueCents) })}</p>
      <div className="cluster">
        {methods
          .filter((m) => m.active)
          .map((method) => (
            <Button key={method.id} size="lg" disabled={busy || amount <= 0} onClick={() => void pay(method.code)} data-testid={`equal-method-${method.code}`}>
              {name(method.name)}
            </Button>
          ))}
      </div>
      {paid === 0 && (
        <Button variant="ghost" onClick={() => setParts(null)}>
          {t('order.equalChange')}
        </Button>
      )}
    </div>
  )
}

function ByItems({ order, onSplit }: { order: OrderDto; onSplit: () => void }) {
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
  )
}
