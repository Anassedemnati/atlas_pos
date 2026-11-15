import { z } from 'zod'
import type { InvoiceDto } from '../dto'
import { def, id } from './define'

/** A4 invoices of closed sale tickets, made out to a company (name, 15-digit ICE). Needs `invoice.create`, but the list. */
export const invoicesChannels = {
  'invoices.create': def<InvoiceDto>()(z.strictObject({ ticketId: id, customerId: id }), { permission: 'invoice.create' }),
  /** The invoices of these tickets, or the latest ones when no ticket is named. */
  'invoices.list': def<InvoiceDto[]>()(z.strictObject({ ticketIds: z.array(id).max(500).optional() }), 'session'),
  /** Saves the PDF where the person chooses in a save dialog; `path` is null when the dialog was cancelled. */
  'invoices.pdf': def<{ path: string | null }>()(z.strictObject({ invoiceId: id }), { permission: 'invoice.create' }),
  /** Queues the invoice on a printer that takes documents (`printer_not_a4` for a thermal one). */
  'invoices.print': def<InvoiceDto>()(z.strictObject({ invoiceId: id, printerId: id }), { permission: 'invoice.create' })
}
