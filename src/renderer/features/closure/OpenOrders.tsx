import { useTranslation } from 'react-i18next'
import type { OrderType } from '@shared/dto'
import { useFormat } from '../till/format'

export interface BlockingOrder {
  id: string
  type: OrderType
  status: string
  tableLabel: string | null
  orderNumber: number | null
  totalCents: number
}

/** The orders that stop a Z: what each one is, and what it comes to. */
export function OpenOrdersList({ orders }: { orders: BlockingOrder[] }) {
  const { t } = useTranslation()
  const { money, orderTitle } = useFormat()
  return (
    <ul className="plain-list" data-testid="blocking-orders">
      {orders.map((order) => (
        <li key={order.id} className="job-row">
          <span className="grow">
            <strong>{orderTitle(order)}</strong>
            <span className="muted"> · {t(`till.type.${order.type}`)}</span>
          </span>
          <strong className="figure">{money(order.totalCents)}</strong>
        </li>
      ))}
    </ul>
  )
}
