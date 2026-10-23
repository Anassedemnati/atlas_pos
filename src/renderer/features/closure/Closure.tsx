import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ZData } from '@shared/dto'
import type { ZHistoryDto } from '@shared/ipc/till'
import { errorMessage, invoke, useApi, useQuery } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, ConfirmDialog, EmptyState, Modal, useToast } from '../../ui'
import { TillLayout } from '../till/TillLayout'
import { useFormat } from '../till/format'
import { can, useTill } from '../till/store'
import { OpenOrdersList, type BlockingOrder } from './OpenOrders'
import { ZReportView } from './ZReportView'

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

export function ClosureScreen() {
  const { t } = useTranslation()
  return (
    <TillLayout
      title={t('closure.title')}
      end={
        <Button variant="secondary" icon="back" onClick={() => navigate('/home')} data-testid="back-home">
          {t('tickets.back')}
        </Button>
      }
    >
      <Closure />
    </TillLayout>
  )
}

/** The day's X report, the Z closure (blocked by open orders) and the history of past Z reports. */
function Closure() {
  const { t } = useTranslation()
  const toast = useToast()
  const api = useApi()
  const data = useTill()
  const { money } = useFormat()
  const x = useQuery('days.xReport', {}, { silent: true, refreshOn: ['ticket.closed', 'day.closed', 'order.changed'] })
  const history = useQuery('days.history', {}, { silent: true, refreshOn: ['day.closed'], enabled: can(data, 'report.x') })
  const [confirm, setConfirm] = useState(false)
  const [blocking, setBlocking] = useState<BlockingOrder[]>([])
  const [done, setDone] = useState<ZData | null>(null)
  const [viewing, setViewing] = useState<ZData | null>(null)
  const [busy, setBusy] = useState(false)

  const closeDay = async () => {
    setConfirm(false)
    setBusy(true)
    const result = await invoke('days.close', {})
    setBusy(false)
    if (result.ok) {
      setBlocking([])
      setDone(result.value.data)
      toast.success(t('closure.done', { number: result.value.data.zNumber ?? '' }))
      return
    }
    const orders = result.error.params?.['orders']
    if (result.error.code === 'open_orders_exist' && Array.isArray(orders)) setBlocking(orders as BlockingOrder[])
    else toast.error(errorMessage(result.error))
  }

  const view = async (row: ZHistoryDto) => {
    const result = await api.call('days.xReport', { dayId: row.dayId })
    if (result.ok) setViewing(result.value)
  }
  const reprint = async (row: ZHistoryDto) => {
    const result = await api.call('days.reprintZ', { zId: row.zId })
    if (result.ok) toast.success(t('closure.zReprinted', { number: row.zNumber }))
  }

  return (
    <div className="closure" data-testid="closure-screen">
      <section className="closure__main">
        {done ? (
          <>
            <ZReportView data={done} />
            <p className="h3" data-testid="z-done">{t('closure.done', { number: done.zNumber ?? '' })}</p>
          </>
        ) : x.data ? (
          <ZReportView data={x.data} />
        ) : (
          <EmptyState icon="chart" title={t('closure.noOpenDay')} />
        )}
        {blocking.length > 0 && (
          <div className="closure__blocked" data-testid="closure-blocked">
            <p className="error-text">{t('closure.blocked')}</p>
            <OpenOrdersList orders={blocking} />
            <div className="cluster">
              {blocking.map((order) => (
                <Button key={order.id} variant="secondary" onClick={() => navigate(`/order/${order.id}`)}>
                  {t('closure.openOrder')}
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className="closure__actions">
          {done ? null : can(data, 'day.close') ? (
            <Button size="xl" onClick={() => setConfirm(true)} disabled={busy || !x.data} data-testid="close-day">
              {t('closure.closeDay')}
            </Button>
          ) : (
            <p className="warn-text">{t('closure.needManager')}</p>
          )}
        </div>
      </section>
      <aside className="closure__history card">
        <h3 className="h3">{t('closure.history')}</h3>
        {(history.data ?? []).length === 0 ? (
          <p className="muted">{t('closure.noHistory')}</p>
        ) : (
          <ul className="plain-list" data-testid="z-history">
            {(history.data ?? []).map((row) => (
              <li key={row.zId} className="job-row">
                <span className="grow">
                  <strong>Z{row.zNumber}</strong> <span className="muted">{date.format(new Date(row.closedAt))}</span>
                  <br />
                  <span className="figure">{money(row.totalCents)}</span>
                </span>
                <Button variant="secondary" onClick={() => void view(row)}>
                  {t('closure.view')}
                </Button>
                <Button variant="secondary" icon="printer" aria-label={t('closure.reprintZ')} onClick={() => void reprint(row)} />
              </li>
            ))}
          </ul>
        )}
      </aside>
      <ConfirmDialog open={confirm} title={t('closure.confirmTitle')} message={t('closure.confirmMessage')} confirmLabel={t('closure.closeDay')} onCancel={() => setConfirm(false)} onConfirm={() => void closeDay()} />
      <Modal open={viewing !== null} onClose={() => setViewing(null)} size="md">
        {viewing && <ZReportView data={viewing} />}
      </Modal>
    </div>
  )
}
