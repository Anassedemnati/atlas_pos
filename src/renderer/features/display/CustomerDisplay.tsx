import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderDto } from '@shared/dto'
import { useEvent } from '../../app/api'
import { Logo } from '../../ui'
import { formatQty, useFormat } from '../till/format'

/** `#/display`: what the customer sees on the second screen: the lines and the total, or the logo when idle. */
export function CustomerDisplay() {
  const { t } = useTranslation()
  const { money, name } = useFormat()
  const [order, setOrder] = useState<OrderDto | null>(null)
  useEvent('display.order', (event) => setOrder(event.order))
  const lines = order?.lines.filter((l) => l.status === 'active') ?? []

  if (!order || lines.length === 0) {
    return (
      <div className="display display--idle" data-testid="display-idle">
        <Logo className="display__logo" />
        <p className="display__welcome">{t('display.welcome')}</p>
      </div>
    )
  }
  return (
    <div className="display" data-testid="display-order">
      <ul className="display__lines">
        {lines.map((line) => (
          <li key={line.id}>
            <span className="figure">{formatQty(line.qtyMilli, line.qtyMilli % 1000 !== 0)}</span>
            <span className="display__name">
              {name(line.name)}
              {line.modifiers.map((m) => (
                <small key={m.id}> + {name(m.name)}</small>
              ))}
            </span>
            <span className="figure">{money(line.netCents)}</span>
          </li>
        ))}
      </ul>
      <div className="display__total">
        <span>{t('display.total')}</span>
        <strong className="figure" data-testid="display-total">{money(order.totals.totalCents)}</strong>
      </div>
    </div>
  )
}
