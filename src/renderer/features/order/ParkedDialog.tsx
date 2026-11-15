import { useTranslation } from 'react-i18next'
import type { OrderSummaryDto } from '@shared/ipc/till'
import { useApi } from '../../app/api'
import { navigate } from '../../app/router'
import { Modal } from '../../ui'
import { minutesSince, useFormat } from '../till/format'

/** The orders put on hold ("mise en attente"): tap one to take it back. */
export function ParkedDialog({ orders, onClose }: { orders: OrderSummaryDto[]; onClose: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const { money, orderTitle } = useFormat()
  const resume = async (order: OrderSummaryDto) => {
    const result = await api.call('orders.resume', { orderId: order.id })
    if (result.ok) {
      onClose()
      navigate(`/order/${order.id}`)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('order.parkedTitle')} size="md">
      {orders.length === 0 ? (
        <p className="muted">{t('order.noParked')}</p>
      ) : (
        <ul className="plain-list" data-testid="parked-orders">
          {orders.map((order) => (
            <li key={order.id}>
              <button type="button" className="order-row" onClick={() => void resume(order)}>
                <strong className="grow">{orderTitle(order)}</strong>
                <span className="muted">{t('floor.minutes', { count: minutesSince(order.openedAt) })}</span>
                <strong className="figure">{money(order.totalCents)}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
