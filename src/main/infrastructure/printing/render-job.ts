import type { TicketSnapshot, ZData } from '@shared/dto'
import { z } from 'zod'
import type { PrintJobKind } from '../../application/ports'
import type { Database } from '../db/connection'
import type { SettingsRepo } from '../db/repos/settings-repo'
import { createTicketsRepo } from '../db/repos/tickets-repo'
import { EscPos } from './escpos'
import { htmlToEscPos } from './render-html'
import { invoiceA4Html, type InvoiceDoc } from './templates/invoice-a4'
import { kitchenDoc } from './templates/kitchen'
import { receiptDoc } from './templates/receipt'
import { zReportDoc } from './templates/z-report'
import { PermanentPrintError, type DriverJob, type PrintDoc, type PrinterRow, type RenderHtmlToBitmap } from './types'

const LocalizedName = z.object({ fr: z.string(), ar: z.string().optional(), en: z.string().optional() })

const KitchenJobPayload = z.object({
  /** Set when the job was sent again after it may already have printed. */
  reprint: z.boolean().optional(),
  ticket: z.object({
    order: z.object({
      type: z.enum(['dine_in', 'takeaway', 'delivery', 'counter']),
      tableLabel: z.string().nullable(),
      covers: z.number(),
      orderNumber: z.number().nullable(),
      waiter: z.string(),
      at: z.string(),
      note: z.string()
    }),
    lines: z.array(
      z.object({
        id: z.string(),
        name: LocalizedName,
        qtyMilli: z.number(),
        modifiers: z.array(z.object({ name: LocalizedName })),
        note: z.string(),
        course: z.number()
      })
    )
  })
})

const ReceiptJobPayload = z.object({ ticketId: z.string().min(1), duplicate: z.boolean().optional() })
const ZJobPayload = z.object({ zId: z.string().min(1) })
const InvoiceJobPayload = z.object({ invoiceId: z.string().min(1) })

function payloadOf<S extends z.ZodType>(schema: S, kind: PrintJobKind, payload: unknown): z.output<S> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new PermanentPrintError('payload_unreadable', `the ${kind} job has no readable payload`)
  return parsed.data
}

/**
 * A document in the form the printer's driver takes. ESC/POS bytes go as they are; HTML for an image printer is
 * rasterised; a system printer gets the HTML; a virtual printer takes both. HTML that stands for a whole page
 * (an invoice) cannot go to a thermal printer, and that is not worth retrying.
 */
export async function docToDriverJob(doc: PrintDoc, printer: PrinterRow, rasterize: RenderHtmlToBitmap): Promise<DriverJob> {
  if ('escpos' in doc) {
    if (printer.kind === 'os-html') throw new PermanentPrintError('bytes_not_supported', 'a system printer takes documents, not ESC/POS bytes')
    return doc.escpos
  }
  if (printer.kind === 'os-html') return { html: doc.html }
  if (doc.raster) return htmlToEscPos(doc.html, doc.widthMm ?? printer.widthMm, rasterize)
  if (printer.kind === 'virtual') return { html: doc.html }
  throw new PermanentPrintError('html_not_supported', `a ${printer.kind} printer cannot print an A4 document`)
}

export interface JobRendererDeps {
  db: Database
  settings: Pick<SettingsRepo, 'get'>
  rasterize: RenderHtmlToBitmap
  /** The business logo as a data URI (printed on raster and paper receipts only). */
  logo?: () => string | undefined
}

export interface JobRenderer {
  /** The job's document for this printer, or null when there is nothing to send (a drawer pulse for a system printer). */
  render(job: { kind: PrintJobKind; payload: unknown }, printer: PrinterRow): Promise<DriverJob | null>
}

/**
 * Turns a queued job into what its printer's driver sends, at the moment it is printed: receipts and credit
 * notes from the frozen ticket snapshot, kitchen tickets from the content frozen in the job, the Z report from
 * its stored figures, an invoice from its row. Unreadable or unsupported jobs are `PermanentPrintError`s.
 */
export function createJobRenderer(deps: JobRendererDeps): JobRenderer {
  const { db, settings } = deps
  const tickets = createTicketsRepo(db)
  const layout = (printer: PrinterRow) => ({ widthMm: printer.widthMm, raster: printer.raster, paper: printer.kind === 'os-html' })

  async function render(job: { kind: PrintJobKind; payload: unknown }, printer: PrinterRow): Promise<DriverJob | null> {
    const finish = (doc: PrintDoc): Promise<DriverJob> => docToDriverJob(doc, printer, deps.rasterize)
    switch (job.kind) {
      case 'receipt': {
        const { ticketId, duplicate } = payloadOf(ReceiptJobPayload, job.kind, job.payload)
        const ticket = tickets.get(ticketId)
        if (!ticket) throw new PermanentPrintError('ticket_not_found', `ticket ${ticketId} does not exist`)
        const snapshot: TicketSnapshot = ticket.snapshot
        return finish(receiptDoc(snapshot, { lang: snapshot.receipt.lang, duplicate: duplicate === true, logo: deps.logo?.(), ...layout(printer) }))
      }
      case 'kitchen':
      case 'kitchen-cancel': {
        const { ticket, reprint } = payloadOf(KitchenJobPayload, job.kind, job.payload)
        return finish(
          kitchenDoc(ticket.order, ticket.lines, { lang: printer.lang, cancelled: job.kind === 'kitchen-cancel', reprint: reprint === true, ...layout(printer) })
        )
      }
      case 'drawer':
        // Only an ESC/POS printer can pulse a drawer; a system printer has nothing to do.
        return printer.kind === 'os-html' ? null : new EscPos().init().drawerPulse().build()
      case 'z': {
        const { zId } = payloadOf(ZJobPayload, job.kind, job.payload)
        const row = db.prepare('SELECT data_json FROM z_reports WHERE id = ?').get(zId) as { data_json: string } | undefined
        if (!row) throw new PermanentPrintError('z_not_found', `Z report ${zId} does not exist`)
        const data = JSON.parse(row.data_json) as ZData
        return finish(zReportDoc(data, settings.get('receipt.lang'), { business: settings.get('business.legal'), ...layout(printer) }))
      }
      case 'invoice': {
        const { invoiceId } = payloadOf(InvoiceJobPayload, job.kind, job.payload)
        const row = db.prepare('SELECT number_label, created_at, customer_json, snapshot_json FROM invoices WHERE id = ?').get(invoiceId) as
          | { number_label: string; created_at: string; customer_json: string; snapshot_json: string }
          | undefined
        if (!row) throw new PermanentPrintError('invoice_not_found', `invoice ${invoiceId} does not exist`)
        const snapshot = JSON.parse(row.snapshot_json) as TicketSnapshot
        const invoice: InvoiceDoc = {
          numberLabel: row.number_label,
          createdAt: row.created_at,
          customer: JSON.parse(row.customer_json) as InvoiceDoc['customer'],
          snapshot
        }
        return finish({ ...invoiceA4Html(invoice, snapshot.receipt.lang), raster: false })
      }
      case 'prebill':
        throw new PermanentPrintError('unsupported_kind', 'there is no pre-bill template yet')
    }
  }

  return { render }
}
