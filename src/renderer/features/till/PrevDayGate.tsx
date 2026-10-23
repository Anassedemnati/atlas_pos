import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DayGateDto } from '@shared/dto'
import { invoke, errorMessage, useQuery } from '../../app/api'
import { Button, Modal, useToast } from '../../ui'
import { OpenOrdersList, type BlockingOrder } from '../closure/OpenOrders'
import { useFormat } from './format'
import { can, signOut, useTill } from './store'

export interface PrevDayGateProps {
  gate: DayGateDto
  /** Carry on without closing: finish the orders that are still open. */
  onContinue: () => void
  onClosed: () => void
}

/**
 * The open business day is over its cut-over (or older than 24 h): the till asks for its Z before any new
 * sale. The X summary is shown; "Clôturer la journée" needs `day.close` (a cashier asks a manager to sign in).
 */
export function PrevDayGate({ gate, onContinue, onClosed }: PrevDayGateProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const data = useTill()
  const { money } = useFormat()
  const canClose = can(data, 'day.close')
  const x = useQuery('days.xReport', {}, { silent: true, enabled: can(data, 'report.x') })
  const [blocking, setBlocking] = useState<BlockingOrder[]>([])
  const [busy, setBusy] = useState(false)

  const close = async () => {
    setBusy(true)
    const result = await invoke('days.close', {})
    setBusy(false)
    if (result.ok) {
      toast.success(t('closure.done', { number: result.value.data.zNumber ?? '' }))
      onClosed()
      return
    }
    const orders = result.error.params?.['orders']
    if (result.error.code === 'open_orders_exist' && Array.isArray(orders)) setBlocking(orders as BlockingOrder[])
    else toast.error(errorMessage(result.error))
  }

  return (
    <Modal open onClose={() => undefined} dismissible={false} title={t('till.gate.title')} size="md">
      <div className="stack" data-testid="day-gate">
        <p>{t('till.gate.message', { number: gate.dayNumber })}</p>
        {x.data && (
          <div className="gate-summary">
            <span className="muted">{t('closure.xTotal')}</span>
            <strong className="figure">{money(x.data.totalCents)}</strong>
            <span className="muted">{t('closure.ticketsCount', { count: x.data.ticketsCount })}</span>
          </div>
        )}
        {blocking.length > 0 && (
          <div>
            <p className="warn-text">{t('closure.blocked')}</p>
            <OpenOrdersList orders={blocking} />
          </div>
        )}
        {!canClose && <p className="warn-text">{t('till.gate.needManager')}</p>}
        <div className="stack">
          {canClose && (
            <Button size="lg" block onClick={() => void close()} disabled={busy} data-testid="gate-close-day">
              {t('till.gate.close')}
            </Button>
          )}
          {blocking.length > 0 && (
            <Button size="lg" variant="secondary" block onClick={onContinue}>
              {t('till.gate.finishOrders')}
            </Button>
          )}
          <Button size="lg" variant="secondary" block onClick={() => void signOut()}>
            {t('till.switchUser')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
