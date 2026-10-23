import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TicketRowDto } from '@shared/ipc/till'
import { useApi, useQuery } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, EmptyState, Pill, ReasonPicker, TextField, useToast } from '../../ui'
import { TillLayout } from '../till/TillLayout'
import { useFormat } from '../till/format'
import { can, setting, useTill } from '../till/store'
import { InvoiceFlow } from './InvoiceFlow'

const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Today's tickets: search by number, print a duplicate, cancel with a reason (a credit note). */
export function TicketsScreen() {
  const { t } = useTranslation()
  return (
    <TillLayout
      title={t('tickets.title')}
      end={
        <Button variant="secondary" icon="back" onClick={() => navigate('/home')} data-testid="back-home">
          {t('tickets.back')}
        </Button>
      }
    >
      <Tickets />
    </TillLayout>
  )
}

function Tickets() {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const data = useTill()
  const { money, orderTitle } = useFormat()
  const [q, setQ] = useState('')
  const [cancelling, setCancelling] = useState<TicketRowDto | null>(null)
  const [invoicing, setInvoicing] = useState<TicketRowDto | null>(null)
  const tickets = useQuery('tickets.list', q.trim() ? { q: q.trim() } : {}, { refreshOn: ['ticket.closed'] })
  const rows = tickets.data ?? []
  const invoiceOn = can(data, 'invoice.create')
  const invoices = useQuery('invoices.list', { ticketIds: rows.map((row) => row.id) }, { silent: true, enabled: tickets.data !== undefined })
  const invoiceOf = (row: TicketRowDto) => (invoices.data ?? []).find((invoice) => invoice.ticketId === row.id)
  const reasons = setting<string[]>(data, 'cancel.reasons', []).map((label) => ({ id: label, label }))

  const reprint = async (row: TicketRowDto) => {
    const result = await api.call('tickets.reprint', { ticketId: row.id })
    if (result.ok) {
      toast.success(t('tickets.reprinted', { label: row.label }))
      tickets.reload()
    }
  }
  const cancel = async (row: TicketRowDto, reason: string) => {
    const result = await api.call('tickets.cancel', { ticketId: row.id, reason })
    if (result.ok) {
      toast.success(t('tickets.cancelled', { label: result.value.label }))
      tickets.reload()
    }
  }

  return (
    <div className="reports" data-testid="tickets-screen">
      <div className="reports__bar">
        <TextField label={t('tickets.search')} hideLabel icon="search" value={q} onChange={setQ} inputMode="numeric" placeholder={t('tickets.searchPlaceholder')} data-testid="ticket-search" />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="printer" title={t('tickets.none')} />
      ) : (
        <ul className="plain-list ticket-list" data-testid="ticket-list">
          {rows.map((row) => (
            <li key={row.id} className="ticket-row" data-testid={`ticket-${row.label}`}>
              <strong className="ticket-row__label figure">{row.label}</strong>
              <span className="ticket-row__time muted">{time.format(new Date(row.closedAt))}</span>
              <span className="grow">
                {orderTitle({ type: row.orderType, tableLabel: row.tableLabel, orderNumber: row.orderNumber })}
                <span className="muted"> · {row.userName}</span>
              </span>
              {row.kind === 'credit' && <Pill tone="danger">{t('tickets.credit', { label: row.refLabel ?? '' })}</Pill>}
              {row.cancelled && <Pill tone="danger">{t('tickets.cancelledTag')}</Pill>}
              {invoiceOf(row) && <Pill tone="info">{invoiceOf(row)!.numberLabel}</Pill>}
              <strong className="figure ticket-row__total">{money(row.totalCents)}</strong>
              <Button variant="secondary" icon="printer" onClick={() => void reprint(row)} data-testid={`reprint-${row.label}`}>
                {t('tickets.reprint')}
              </Button>
              {invoiceOn && row.kind === 'sale' && (!row.cancelled || invoiceOf(row)) && (
                <Button variant="secondary" icon="disk" onClick={() => setInvoicing(row)} data-testid={`invoice-${row.label}`}>
                  {t('tickets.invoice.button')}
                </Button>
              )}
              {row.kind === 'sale' && !row.cancelled && (
                <Button variant="secondary" icon="close" onClick={() => setCancelling(row)} data-testid={`cancel-${row.label}`}>
                  {t('tickets.cancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {invoicing && (
        <InvoiceFlow
          ticket={invoicing}
          invoice={invoiceOf(invoicing)}
          onClose={() => setInvoicing(null)}
          onCreated={() => invoices.reload()}
        />
      )}
      <ReasonPicker
        open={cancelling !== null}
        kind="void"
        title={t('tickets.cancelReason')}
        reasons={reasons.length > 0 ? reasons : undefined}
        onCancel={() => setCancelling(null)}
        onPick={(reason) => {
          const row = cancelling
          setCancelling(null)
          if (row) void cancel(row, reason)
        }}
      />
    </div>
  )
}

