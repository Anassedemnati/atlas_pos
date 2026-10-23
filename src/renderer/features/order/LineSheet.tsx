import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto, OrderLineDto } from '@shared/dto'
import { invoke } from '../../app/api'
import { Button, Modal, ReasonPicker, TextField } from '../../ui'
import { firstToken, useGuard, type Tokens } from '../till/Override'
import { formatQty, useFormat } from '../till/format'
import { DiscountDialog } from './DiscountDialog'
import { QtyDialog, WeightDialog } from './dialogs'
import { useTill } from '../till/store'

export interface LineSheetProps {
  order: OrderDto
  line: OrderLineDto
  onClose: () => void
  onOrder: (order: OrderDto) => void
}

type Sub = null | 'qty' | 'note' | 'discount' | 'free' | 'void'

/** The approvals a void can need: the discount limit, and (a line already in the kitchen) `order.void_sent`. */
const voidTokens = (tokens: Tokens) => ({ overrideTokenId: tokens['order.discount.override'], voidOverrideTokenId: tokens['order.void_sent'] })

/** What can be done to one ticket line: quantity, note, discount, offer, remove. A line already in the kitchen is frozen. */
export function LineSheet({ order, line, onClose, onOrder }: LineSheetProps) {
  const { t } = useTranslation()
  const { guard } = useGuard()
  const { catalog } = useTill()
  const { name, money } = useFormat()
  const [sub, setSub] = useState<Sub>(null)
  const [note, setNote] = useState(line.note)
  const sent = line.sentAt !== null
  const product = catalog.products.find((p) => p.id === line.productId)
  const byWeight = product?.soldByWeight ?? false
  const ids = { orderId: order.id, lineId: line.id }

  const done = (result: { ok: true; value: OrderDto } | { ok: false }) => {
    if (result.ok) {
      onOrder(result.value)
      onClose()
    }
  }

  if (sub === 'qty') {
    const confirm = async (qtyMilli: number) => done(await guard((tokens) => invoke('orders.setLineQty', { ...ids, qtyMilli, overrideTokenId: firstToken(tokens) })))
    return byWeight && product ? (
      <WeightDialog product={product} initial={line.qtyMilli} onCancel={() => setSub(null)} onConfirm={(q) => void confirm(q)} />
    ) : (
      <QtyDialog title={name(line.name)} initial={line.qtyMilli} byWeight={byWeight} onCancel={() => setSub(null)} onConfirm={(q) => void confirm(q)} />
    )
  }
  if (sub === 'discount') {
    return (
      <DiscountDialog
        title={`${t('order.discount')} · ${name(line.name)}`}
        current={line.discount}
        onCancel={() => setSub(null)}
        onApply={async (discount) => done(await guard((tokens) => invoke('orders.setLineDiscount', { ...ids, discount, overrideTokenId: firstToken(tokens) })))}
      />
    )
  }
  if (sub === 'free') {
    return (
      <ReasonPicker
        open
        kind="discount"
        title={t('order.freeReason')}
        onCancel={() => setSub(null)}
        onPick={async (reason) =>
          done(
            await guard((tokens) =>
              invoke('orders.setFree', { ...ids, free: true, reason, overrideTokenId: tokens['order.free_item'], discountOverrideTokenId: tokens['order.discount.override'] })
            )
          )
        }
      />
    )
  }
  if (sub === 'void') {
    return (
      <ReasonPicker
        open
        kind="void"
        title={t('order.voidReason')}
        onCancel={() => setSub(null)}
        onPick={async (reason) => done(await guard((tokens) => invoke('orders.voidLine', { ...ids, reason, ...voidTokens(tokens) })))}
      />
    )
  }

  return (
    <Modal open onClose={onClose} title={`${formatQty(line.qtyMilli, byWeight)} × ${name(line.name)}`} size="sm">
      <div className="stack" data-testid="line-sheet">
        <p className="muted">
          {money(line.netCents)}
          {sent && ` · ${t('order.sent')}`}
          {line.free && ` · ${t('order.free')}`}
        </p>
        {sub === 'note' ? (
          <>
            <TextField label={t('order.note')} value={note} onChange={setNote} maxLength={200} autoFocus />
            <Button
              size="lg"
              block
              onClick={async () => {
                const result = await guard(() => invoke('orders.setNote', { orderId: order.id, lineId: line.id, note }))
                done(result)
              }}
            >
              {t('common.save')}
            </Button>
          </>
        ) : (
          <div className="sheet-grid">
            <Button variant="secondary" size="lg" disabled={sent} onClick={() => setSub('qty')} data-testid="line-qty">
              {t('order.quantity')}
            </Button>
            <Button variant="secondary" size="lg" disabled={sent} onClick={() => setSub('note')} data-testid="line-note">
              {t('order.note')}
            </Button>
            <Button variant="secondary" size="lg" onClick={() => setSub('discount')} data-testid="line-discount">
              {t('order.discount')}
            </Button>
            {line.free ? (
              <Button
                variant="secondary"
                size="lg"
                onClick={async () =>
                  done(await guard((tokens) => invoke('orders.setFree', { ...ids, free: false, reason: t('order.chargeAgain'), overrideTokenId: tokens['order.free_item'], discountOverrideTokenId: tokens['order.discount.override'] })))
                }
              >
                {t('order.chargeAgain')}
              </Button>
            ) : (
              <Button variant="secondary" size="lg" onClick={() => setSub('free')} data-testid="line-free">
                {t('order.free')}
              </Button>
            )}
            <Button
              variant="danger"
              size="lg"
              onClick={() => (sent ? setSub('void') : void guard((tokens) => invoke('orders.voidLine', { ...ids, reason: '', ...voidTokens(tokens) })).then(done))}
              data-testid="line-void"
            >
              {t('order.remove')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
