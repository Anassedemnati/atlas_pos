import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto, PaymentDto } from '@shared/dto'
import { parseMoney } from '@shared/money'
import { invoke, useApi } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, Keypad, ReasonPicker, useToast } from '../../ui'
import { cx } from '../../ui/metrics'
import { TillLayout } from '../till/TillLayout'
import { firstToken, useGuard } from '../till/Override'
import { useFormat } from '../till/format'
import { useTill } from '../till/store'

const QUICK_CASH = [5000, 10000, 20000]

/** The payment screen of an order (`#/pay/:id`). */
export function PayScreen({ orderId }: { orderId: string }) {
  const { t } = useTranslation()
  return (
    <TillLayout
      title={t('payment.title')}
      end={
        <Button variant="secondary" icon="back" onClick={() => navigate(`/order/${orderId}`)} data-testid="back-to-order">
          {t('payment.backToOrder')}
        </Button>
      }
    >
      <Pay orderId={orderId} />
    </TillLayout>
  )
}

function Pay({ orderId }: { orderId: string }) {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const { guard } = useGuard()
  const { methods } = useTill()
  const { money, name, orderTitle } = useFormat()
  const [order, setOrder] = useState<OrderDto | null>(null)
  const [method, setMethod] = useState<string>('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<PaymentDto | null>(null)
  const active = methods.filter((m) => m.active).sort((a, b) => a.sort - b.sort)
  const current = method || active[0]?.code || ''
  const isCash = current === 'cash'

  const load = useCallback(async () => {
    const result = await invoke('orders.get', { orderId })
    if (!result.ok || result.value.status !== 'open') return void navigate('/home')
    setOrder(result.value)
  }, [orderId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void invoke('display.update', { orderId })
    return () => void invoke('display.update', { orderId: null })
  }, [orderId])

  if (!order) return null
  const due = order.dueCents

  /** One payment: cash hands over `tendered` (the part above what is due comes back as change), other methods take the amount. */
  const add = async (methodCode: string, amountCents: number, tenderedCents?: number) => {
    if (busy || amountCents <= 0) return
    setBusy(true)
    const result = await api.call('orders.addPayment', {
      orderId,
      payment: { methodCode, amountCents, ...(tenderedCents !== undefined ? { tenderedCents } : {}) }
    })
    setBusy(false)
    if (result.ok) {
      setOrder(result.value)
      setText('')
    }
  }

  const tender = (cents: number) => {
    if (isCash) void add(current, Math.min(cents, due), cents)
    else void add(current, cents)
  }
  const typed = parseMoney(text)

  const close = async () => {
    setBusy(true)
    const result = await guard((tokens) => invoke('orders.close', { orderId, overrideTokenId: firstToken(tokens) }))
    setBusy(false)
    if (result.ok) {
      toast.success(t('payment.closed', { label: result.value.label }))
      navigate('/home')
    }
  }

  const settled = due === 0 && order.payments.length > 0

  return (
    <div className="pay" data-testid="pay-screen">
      <section className="pay__summary card">
        <p className="muted">{orderTitle(order)}</p>
        <div className="pay__line">
          <span>{t('order.total')}</span>
          <strong className="figure" data-testid="pay-total">{money(order.totals.totalCents)}</strong>
        </div>
        <div className="pay__line">
          <span>{t('payment.paid')}</span>
          <strong className="figure">{money(order.paidCents)}</strong>
        </div>
        <div className={cx('pay__due', settled && 'pay__due--done')}>
          <span>{t('payment.due')}</span>
          <strong className="figure" data-testid="pay-due">{money(due)}</strong>
        </div>
        <ul className="plain-list" data-testid="payments">
          {order.payments.map((p) => (
            <li key={p.id} className="job-row">
              <span className="grow">
                {name(methods.find((m) => m.code === p.methodCode)?.name ?? { fr: p.methodCode })}
                {p.tenderedCents > p.amountCents && <small className="muted"> ({money(p.tenderedCents)})</small>}
              </span>
              <strong className="figure">{money(p.amountCents)}</strong>
              <Button variant="secondary" icon="close" aria-label={t('common.remove')} onClick={() => setRemoving(p)} />
            </li>
          ))}
        </ul>
        {order.changeCents > 0 && (
          <div className="pay__change" data-testid="pay-change">
            <span>{t('payment.change')}</span>
            <strong className="figure">{money(order.changeCents)}</strong>
          </div>
        )}
      </section>

      <section className="pay__entry">
        {settled ? (
          <div className="pay__done">
            <p className="h2">{order.changeCents > 0 ? t('payment.giveChange') : t('payment.settled')}</p>
            <Button size="xl" block onClick={() => void close()} disabled={busy} className="pay-button" data-testid="pay-validate">
              {t('payment.validate')}
            </Button>
          </div>
        ) : (
          <>
            <div className="pay__methods" role="tablist">
              {active.map((m) => (
                <Button key={m.id} variant={m.code === current ? 'primary' : 'secondary'} size="lg" onClick={() => { setMethod(m.code); setText('') }} data-testid={`method-${m.code}`}>
                  {name(m.name)}
                </Button>
              ))}
            </div>
            <div className="pay__quick">
              <Button variant="secondary" size="lg" disabled={busy} onClick={() => tender(due)} data-testid="quick-exact">
                {t('payment.exact')}
              </Button>
              {isCash &&
                QUICK_CASH.map((cents) => (
                  <Button key={cents} variant="secondary" size="lg" disabled={busy} onClick={() => tender(cents)} data-testid={`quick-${cents / 100}`}>
                    {money(cents).replace(',00', '')}
                  </Button>
                ))}
            </div>
            <Keypad
              mode="money"
              value={text}
              onChange={setText}
              onEnter={() => typed !== null && tender(typed)}
              enterLabel={isCash ? t('payment.addCash') : t('payment.addAmount')}
              disabled={busy}
              captureKeys
              aria-label={t('payment.amount')}
            />
          </>
        )}
      </section>

      <ReasonPicker
        open={removing !== null}
        kind="void"
        title={t('payment.removeReason')}
        onCancel={() => setRemoving(null)}
        onPick={async (reason) => {
          const payment = removing
          setRemoving(null)
          if (!payment) return
          const result = await guard((tokens) => invoke('orders.removePayment', { orderId, paymentId: payment.id, reason, overrideTokenId: firstToken(tokens) }))
          if (result.ok) setOrder(result.value)
        }}
      />
    </div>
  )
}
