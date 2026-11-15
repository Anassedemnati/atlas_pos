import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InvoiceDto } from '@shared/dto'
import type { TicketRowDto } from '@shared/ipc/till'
import { useApi, useQuery } from '../../app/api'
import { Button, Modal, useToast } from '../../ui'
import { CustomerPicker } from '../till/CustomerPicker'
import { useFormat } from '../till/format'

/** The printer kinds whose driver takes an A4 document (the main process refuses any other). */
const DOCUMENT_PRINTERS = ['os-html', 'virtual']

export interface InvoiceFlowProps {
  ticket: TicketRowDto
  /** The invoice the ticket already has: only its PDF and printing are offered. */
  invoice: InvoiceDto | undefined
  onClose: () => void
  /** An invoice was just made. */
  onCreated: () => void
}

/** The invoice of a ticket: a company customer is picked (or created), the invoice is made, then saved as a PDF or printed. */
export function InvoiceFlow({ ticket, invoice: existing, onClose, onCreated }: InvoiceFlowProps) {
  const { t } = useTranslation()
  const api = useApi()
  const [made, setMade] = useState<InvoiceDto | null>(null)
  const invoice = existing ?? made

  const create = async (customerId: string) => {
    const result = await api.call('invoices.create', { ticketId: ticket.id, customerId })
    if (!result.ok) return
    setMade(result.value)
    onCreated()
  }

  if (!invoice) return <CustomerPicker title={t('tickets.invoice.pickTitle', { label: ticket.label })} requireCompany onPick={(customer) => void create(customer.id)} onClose={onClose} />
  return <InvoiceDialog invoice={invoice} onClose={onClose} />
}

/** An invoice made: its number, and what to do with it. */
function InvoiceDialog({ invoice, onClose }: { invoice: InvoiceDto; onClose: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const { money } = useFormat()
  const printers = useQuery('printing.printers', {}, { silent: true })
  const a4 = (printers.data ?? []).filter((p) => p.active && DOCUMENT_PRINTERS.includes(p.kind))

  const savePdf = async () => {
    const result = await api.call('invoices.pdf', { invoiceId: invoice.id })
    if (result.ok && result.value.path) toast.success(t('tickets.invoice.saved', { number: invoice.numberLabel }))
  }
  const print = async (printerId: string, name: string) => {
    const result = await api.call('invoices.print', { invoiceId: invoice.id, printerId })
    if (result.ok) toast.success(t('tickets.invoice.printed', { number: invoice.numberLabel, printer: name }))
  }

  return (
    <Modal open onClose={onClose} title={t('tickets.invoice.title', { number: invoice.numberLabel })} size="md">
      <div className="stack" data-testid="invoice-dialog">
        <p>
          <strong data-testid="invoice-number">{invoice.numberLabel}</strong> · {invoice.customer.companyName || invoice.customer.name}
          <br />
          <span className="muted">
            {t('tickets.invoice.forTicket', { label: invoice.ticketLabel })} · {money(invoice.totalCents)}
          </span>
        </p>
        <Button size="lg" icon="disk" onClick={() => void savePdf()} data-testid="invoice-pdf">
          {t('tickets.invoice.savePdf')}
        </Button>
        {a4.length === 0 ? (
          <p className="muted">{t('tickets.invoice.noA4Printer')}</p>
        ) : (
          a4.map((printer) => (
            <Button key={printer.id} size="lg" variant="secondary" icon="printer" onClick={() => void print(printer.id, printer.name)} data-testid={`invoice-print-${printer.name}`}>
              {t('tickets.invoice.printOn', { printer: printer.name })}
            </Button>
          ))
        )}
        <Button size="lg" variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </Modal>
  )
}
