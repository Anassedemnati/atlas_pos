import type { InvoiceDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { createCustomersRepo } from '../../../infrastructure/db/repos/customers-repo'
import { createInvoicesRepo } from '../../../infrastructure/db/repos/invoices-repo'
import { createTicketsRepo } from '../../../infrastructure/db/repos/tickets-repo'
import { nextSequence } from '../../../infrastructure/db/sequences'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { readInvoiceDoc } from '../../../infrastructure/printing/invoice-source'
import { readPrinter } from '../../../infrastructure/printing/router'
import { invoiceA4Html } from '../../../infrastructure/printing/templates/invoice-a4'
import type { RenderHtmlToPdf } from '../../../infrastructure/printing/types'
import { AppErrorException } from '../../errors'
import type { Clock, PrintSpooler } from '../../ports'
import { attempt, attemptSync, invalidInput } from '../users/outcome'

export interface InvoicesDeps {
  db: Database
  uow: UnitOfWork
  clock: Clock
  spooler: PrintSpooler
  /** Electron's `printToPDF`; without it (a test, a failed start) PDFs are `pdf_unavailable`. */
  renderPdf?: RenderHtmlToPdf
}

export interface InvoicesService {
  /**
   * Needs `invoice.create`. The A4 invoice of a closed sale ticket, made out to a company customer (`isCompany`
   * with a 15-digit ICE: `customer_not_company` otherwise). A ticket has one invoice (`already_invoiced`), a
   * credit note or a cancelled sale none (`not_a_sale`, `already_cancelled`). The number is
   * `F-<year>-<5 digits>`, gap-free within the year: it is allocated in the same transaction as the row, which
   * never changes afterwards; the customer and the ticket's figures are copied into it.
   */
  createInvoice(session: Session, ticketId: string, customerId: string): Result<InvoiceDto>
  /** The invoices of these tickets (or the latest ones). */
  listInvoices(session: Session, ticketIds?: string[]): Result<InvoiceDto[]>
  /** Needs `invoice.create`. The invoice as a PDF, rendered from the same row the printer reads. */
  invoicePdf(session: Session, invoiceId: string): Promise<Result<{ bytes: Uint8Array; fileName: string }>>
  /**
   * Needs `invoice.create`. Queues the invoice on a printer that takes documents (a system printer, or a virtual one):
   * a thermal printer would fail the job for good, so it is refused up front (`printer_not_a4`).
   */
  printInvoice(session: Session, invoiceId: string, printerId: string): Result<InvoiceDto>
}

/** The ICE (identifiant commun de l'entreprise): 15 digits. */
const ICE = /^\d{15}$/

/** The printer kinds whose driver takes an A4 document. */
const DOCUMENT_PRINTERS: readonly string[] = ['os-html', 'virtual']

export function createInvoicesService(deps: InvoicesDeps): InvoicesService {
  const { db, uow } = deps
  const invoices = createInvoicesRepo(db)
  const customers = createCustomersRepo(db)
  const tickets = createTicketsRepo(db)

  const load = (invoiceId: string): InvoiceDto => {
    const invoice = typeof invoiceId === 'string' ? invoices.get(invoiceId) : undefined
    if (!invoice) throw invalidInput('invoiceId', 'unknown invoice')
    return invoice
  }

  function create(session: Session, ticketId: string, customerId: string): InvoiceDto {
    requirePermission(session, 'invoice.create')
    return uow.run((tx) => {
      const ticket = typeof ticketId === 'string' ? tickets.get(ticketId) : undefined
      if (!ticket) throw invalidInput('ticketId', 'unknown ticket')
      if (ticket.kind !== 'sale') throw new AppErrorException('not_a_sale')
      if (tickets.creditOf(ticket.id) !== undefined) throw new AppErrorException('already_cancelled')
      // Checked before the number is taken: a refusal never burns one (the UNIQUE constraint would only report it as a failure).
      if (invoices.ofTicket(ticket.id) !== undefined) throw new AppErrorException('already_invoiced')
      const customer = typeof customerId === 'string' ? customers.get(customerId) : undefined
      if (!customer) throw invalidInput('customerId', 'unknown customer')
      if (!customer.isCompany || !ICE.test(customer.ice)) throw new AppErrorException('customer_not_company')

      const now = tx.clock.now()
      const year = now.getFullYear()
      const numberLabel = `F-${year}-${String(nextSequence(tx.db, `invoice-${year}`)).padStart(5, '0')}`
      const id = newId()
      invoices.insert(tx, {
        id,
        numberLabel,
        ticketId: ticket.id,
        customer: { name: customer.name, companyName: customer.companyName, address: customer.address, ice: customer.ice, phone: customer.phone },
        createdAt: now.toISOString(),
        userId: session.userId,
        snapshot: ticket.snapshot
      })
      appendEvent(
        tx.db,
        {
          type: 'invoice.created',
          entity: 'invoice',
          entityId: id,
          userId: session.userId,
          data: { numberLabel, ticketId: ticket.id, ticketLabel: ticket.label, customerId: customer.id, totalCents: ticket.totalCents }
        },
        tx.clock
      )
      return load(id)
    })
  }

  return {
    createInvoice: (session, ticketId, customerId) => attemptSync(() => create(session, ticketId, customerId)),

    listInvoices: (_session, ticketIds) => attemptSync(() => invoices.list(ticketIds)),

    invoicePdf: (session, invoiceId) =>
      attempt(async () => {
        requirePermission(session, 'invoice.create')
        const invoice = load(invoiceId)
        if (!deps.renderPdf) throw new AppErrorException('pdf_unavailable')
        const doc = readInvoiceDoc(db, invoice.id)
        if (!doc) throw invalidInput('invoiceId', 'unknown invoice')
        const pdf = await deps.renderPdf(invoiceA4Html(doc, doc.snapshot.receipt.lang).html)
        return { bytes: new Uint8Array(pdf), fileName: `${invoice.numberLabel}.pdf` }
      }),

    printInvoice: (session, invoiceId, printerId) =>
      attemptSync(() => {
        requirePermission(session, 'invoice.create')
        return uow.run((tx) => {
          const invoice = load(invoiceId)
          const printer = typeof printerId === 'string' ? readPrinter(db, printerId) : undefined
          if (!printer || !printer.active) throw invalidInput('printerId', 'unknown printer')
          if (!DOCUMENT_PRINTERS.includes(printer.kind)) throw new AppErrorException('printer_not_a4', { printerId: printer.id })
          deps.spooler.enqueue(tx, { target: { printerId: printer.id }, kind: 'invoice', payload: { invoiceId: invoice.id } })
          appendEvent(
            tx.db,
            { type: 'invoice.printed', entity: 'invoice', entityId: invoice.id, userId: session.userId, data: { printerId: printer.id } },
            tx.clock
          )
          return invoice
        })
      })
  }
}
