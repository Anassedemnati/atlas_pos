import type { invoicesChannels } from '@shared/ipc/invoices'
import { writeFileAtomic } from '../../infrastructure/fs/atomic'
import { ok, type Handlers } from './context'

/** A4 invoices: create, list, save as PDF, print. */
export const invoicesHandlers: Handlers<keyof typeof invoicesChannels> = {
  'invoices.create': ({ ticketId, customerId }, ctx) => ctx.services().invoices.createInvoice(ctx.session(), ticketId, customerId),
  'invoices.list': ({ ticketIds }, ctx) => ctx.services().invoices.listInvoices(ctx.session(), ticketIds),
  'invoices.pdf': async ({ invoiceId }, ctx, { shell }) => {
    const pdf = await ctx.services().invoices.invoicePdf(ctx.session(), invoiceId)
    if (!pdf.ok) return pdf
    // The file is written here, from the path the person chose in the system dialog: the bytes never cross the IPC.
    const path = await shell.saveFile(ctx.windowId, { title: pdf.value.fileName, defaultName: pdf.value.fileName, extensions: ['pdf'] })
    if (path === null) return ok({ path: null })
    writeFileAtomic(path, pdf.value.bytes)
    return ok({ path })
  },
  'invoices.print': ({ invoiceId, printerId }, ctx) => ctx.services().invoices.printInvoice(ctx.session(), invoiceId, printerId)
}
