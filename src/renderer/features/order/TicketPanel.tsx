import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto, OrderLineDto } from '@shared/dto'
import { Button, Icon, Tabs } from '../../ui'
import { formatQty, useFormat } from '../till/format'

export interface TicketPanelProps {
  order: OrderDto | null
  /** Before the first item, a café counter order can still be eaten in or taken away. */
  counterType: 'counter' | 'takeaway'
  onCounterType?: (type: 'counter' | 'takeaway') => void
  kitchen: boolean
  canPrebill: boolean
  canSplit: boolean
  busy: boolean
  onLine: (line: OrderLineDto) => void
  onSend: () => void
  onNextCourse: () => void
  onPrebill: () => void
  onDiscount: () => void
  onSplit: () => void
  onPay: () => void
  onPark?: () => void
  /** Change the number of guests (a table). */
  onCovers?: () => void
  /** Pick, change or remove the customer of the order. */
  onCustomer?: () => void
  /** The customer of the order, when it has one. */
  customerName?: string | null
}

/** The ticket of the order in progress: lines, totals and the actions on the bill (mockup 06). */
export function TicketPanel(props: TicketPanelProps) {
  const { t } = useTranslation()
  const { money, name, orderTitle } = useFormat()
  const [more, setMore] = useState(false)
  const { order } = props
  const lines = order?.lines.filter((l) => l.status === 'active') ?? []
  const unsent = lines.filter((l) => l.sentAt === null)
  const anySent = lines.some((l) => l.sentAt !== null)
  const empty = lines.length === 0
  const discount = order ? order.totals.lineDiscountsCents + order.totals.ticketDiscountCents : 0

  return (
    <aside className="ticket" data-testid="ticket-panel">
      <header className="ticket__head">
        <Icon name={order?.tableLabel ? 'utensils' : 'cart'} size={32} />
        <div className="grow">
          <h2 className="h3" data-testid="ticket-title">
            {order ? orderTitle(order) : t('till.type.counter')}
          </h2>
          <p className="muted">
            {order?.tableLabel
              ? t('floor.covers', { count: order.covers })
              : order
                ? t(`till.type.${order.type}`)
                : null}
            {props.customerName && <span data-testid="ticket-customer-name"> · {props.customerName}</span>}
          </p>
        </div>
        {order && (props.onPark || props.onCovers || props.onCustomer) && (
          <div className="ticket__more">
            <Button variant="secondary" icon="plus" aria-label={t('order.more')} onClick={() => setMore(!more)} data-testid="ticket-more" />
            {more && (
              <div className="ticket__menu">
                {props.onCovers && (
                  <Button variant="secondary" onClick={() => { setMore(false); props.onCovers?.() }} data-testid="ticket-covers">
                    {t('order.coversEdit')}
                  </Button>
                )}
                {props.onCustomer && (
                  <Button variant="secondary" onClick={() => { setMore(false); props.onCustomer?.() }} data-testid="ticket-customer">
                    {t('order.customer')}
                  </Button>
                )}
                {props.onPark && (
                  <Button variant="secondary" onClick={() => { setMore(false); props.onPark?.() }} data-testid="ticket-park">
                    {t('order.park')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </header>
      {!order && props.onCounterType && (
        <Tabs
          tabs={[
            { id: 'counter', label: t('till.type.counter') },
            { id: 'takeaway', label: t('till.type.takeaway') }
          ]}
          value={props.counterType}
          onChange={(id) => props.onCounterType?.(id as 'counter' | 'takeaway')}
          aria-label={t('order.serviceType')}
          className="ticket__types"
        />
      )}

      <div className="ticket__lines" data-testid="ticket-lines">
        {empty ? (
          <p className="ticket__empty muted">{t('order.emptyTicket')}</p>
        ) : (
          <ul className="plain-list">
            {lines.map((line) => (
              <li key={line.id}>
                <button type="button" className="ticket-line" onClick={() => props.onLine(line)} data-testid={`line-${line.seq}`}>
                  <span className="ticket-line__qty figure">{formatQty(line.qtyMilli, line.qtyMilli % 1000 !== 0)}</span>
                  <span className="ticket-line__body">
                    <span className="ticket-line__name">
                      {name(line.name)}
                      {line.sentAt && <Icon name="check" size={18} strokeWidth={3} />}
                    </span>
                    {line.modifiers.map((m) => (
                      <span key={m.id} className="ticket-line__sub">
                        + {name(m.name)}
                      </span>
                    ))}
                    {line.note && <span className="ticket-line__sub">» {line.note}</span>}
                    {line.free && <span className="chip chip--free">{t('order.free')}</span>}
                    {line.discount && !line.free && (
                      <span className="chip chip--promo">{line.discount.kind === 'pct' ? `-${line.discount.bp / 100} %` : `-${money(line.discount.cents)}`}</span>
                    )}
                  </span>
                  <span className="ticket-line__amount figure">{money(line.netCents)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="ticket__foot">
        {order && discount > 0 && (
          <div className="ticket__row muted">
            <span>{t('order.discount')}</span>
            <span className="figure">-{money(discount)}</span>
          </div>
        )}
        <div className="ticket__row">
          <span className="muted">
            {t('order.total')} <small>({t('order.vatIncluded')})</small>
          </span>
          <strong className="ticket__total figure" data-testid="ticket-total">
            {money(order?.totals.totalCents ?? 0)}
          </strong>
        </div>
        {props.kitchen && (
          <Button size="lg" block iconEnd="next" className="icon--mirror-btn" disabled={props.busy || unsent.length === 0} onClick={props.onSend} data-testid="send-kitchen">
            {t('order.sendKitchen')}
          </Button>
        )}
        {props.kitchen && anySent && unsent.length > 0 && (
          <Button size="md" variant="ghost" block onClick={props.onNextCourse} data-testid="next-course">
            {t('order.nextCourse')}
          </Button>
        )}
        <div className="ticket__tools">
          {props.canPrebill && (
            <Button variant="secondary" icon="printer" disabled={props.busy || empty} onClick={props.onPrebill} data-testid="prebill">
              {t('order.prebill')}
            </Button>
          )}
          <Button variant="secondary" icon="percent" disabled={props.busy || empty} onClick={props.onDiscount} data-testid="discount">
            {t('order.discount')}
          </Button>
          {props.canSplit && (
            <Button variant="secondary" icon="split" disabled={props.busy || empty} onClick={props.onSplit} data-testid="split">
              {t('order.split')}
            </Button>
          )}
        </div>
        <Button size="xl" block className="pay-button" disabled={props.busy || empty} onClick={props.onPay} data-testid="pay">
          {t('order.pay')}
        </Button>
      </footer>
    </aside>
  )
}
