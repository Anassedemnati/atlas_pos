import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CustomerDto, TicketDto } from '../../src/shared/dto'
import { addPrinter } from '../helpers/printing'
import { code, ok, salesHarness, type SalesHarness } from '../helpers/sales'

describe('invoices', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const company = (over: Partial<Parameters<SalesHarness['customers']['saveCustomer']>[1]> = {}): CustomerDto =>
    ok(h.customers.saveCustomer(h.manager, { name: 'Karim Alaoui', companyName: 'Alaoui SARL', address: '5 rue Atlas, Casablanca', ice: '002233445000011', isCompany: true, ...over }))

  /** A closed sale: a tajine (70,00 DH) and a tea (12,00 DH), paid in cash. */
  const sale = (): TicketDto => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.tajine, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 8200 }))
    return ok(h.tickets.closeOrder(h.cashier, order.id))
  }

  it('numbers invoices F-YYYY-NNNNN in order, copies the customer and the ticket, and logs the creation', () => {
    const first = ok(h.invoices.createInvoice(h.manager, sale().id, company().id))
    const secondTicket = sale()
    const second = ok(h.invoices.createInvoice(h.manager, secondTicket.id, company().id))
    expect([first.numberLabel, second.numberLabel]).toEqual(['F-2026-00001', 'F-2026-00002'])
    expect(first).toMatchObject({
      ticketLabel: '000001',
      totalCents: 8200,
      userId: h.manager.userId,
      customer: { name: 'Karim Alaoui', companyName: 'Alaoui SARL', address: '5 rue Atlas, Casablanca', ice: '002233445000011', phone: '' }
    })
    const row = h.t.db.prepare('SELECT customer_json, snapshot_json FROM invoices WHERE id = ?').get(second.id) as { customer_json: string; snapshot_json: string }
    expect(JSON.parse(row.snapshot_json)).toEqual(secondTicket.snapshot)
    expect(h.eventRows('invoice.created')).toHaveLength(2)
  })

  it('a ticket has one invoice: the second is refused as already_invoiced and does not use a number', () => {
    const ticket = sale()
    const customer = company()
    ok(h.invoices.createInvoice(h.manager, ticket.id, customer.id))
    expect(code(h.invoices.createInvoice(h.manager, ticket.id, customer.id))).toBe('already_invoiced')
    const next = ok(h.invoices.createInvoice(h.manager, sale().id, customer.id))
    expect(next.numberLabel).toBe('F-2026-00002')
    expect(h.count('invoices')).toBe(2)
  })

  it('refuses a customer that is not a company with a valid ICE, without using a number', () => {
    const ticket = sale()
    const person = ok(h.customers.saveCustomer(h.manager, { name: 'Sara' }))
    expect(code(h.invoices.createInvoice(h.manager, ticket.id, person.id))).toBe('customer_not_company')
    // A company flag with no ICE cannot even be saved, so only an unflagged customer with an ICE remains to refuse.
    const iceOnly = ok(h.customers.saveCustomer(h.manager, { name: 'Omar', ice: '002233445000011' }))
    expect(code(h.invoices.createInvoice(h.manager, ticket.id, iceOnly.id))).toBe('customer_not_company')
    expect(code(h.invoices.createInvoice(h.manager, ticket.id, 'nobody'))).toBe('invalid_input')
    expect(ok(h.invoices.createInvoice(h.manager, ticket.id, company().id)).numberLabel).toBe('F-2026-00001')
  })

  it('needs invoice.create, and only a sale that was not cancelled can be invoiced', () => {
    const ticket = sale()
    const customer = company()
    expect(code(h.invoices.createInvoice(h.cashier, ticket.id, customer.id))).toBe('forbidden')
    const credit = ok(h.tickets.cancelTicket(h.manager, ticket.id, 'Erreur'))
    expect(code(h.invoices.createInvoice(h.manager, ticket.id, customer.id))).toBe('already_cancelled')
    expect(code(h.invoices.createInvoice(h.manager, credit.id, customer.id))).toBe('not_a_sale')
    expect(code(h.invoices.createInvoice(h.manager, 'nope', customer.id))).toBe('invalid_input')
    expect(h.count('invoices')).toBe(0)
  })

  it('the yearly sequence starts again on January 1st, whatever year the ticket was sold in', () => {
    const customer = company()
    const december = sale()
    const other = sale()
    expect(ok(h.invoices.createInvoice(h.manager, december.id, customer.id)).numberLabel).toBe('F-2026-00001')
    h.clock.advance(new Date(2027, 0, 1, 9).getTime() - h.clock.now().getTime())
    expect(ok(h.invoices.createInvoice(h.manager, other.id, customer.id)).numberLabel).toBe('F-2027-00001')
  })

  it('an invoice row never changes: not by the customer being edited, not by SQL', () => {
    const customer = company()
    const invoice = ok(h.invoices.createInvoice(h.manager, sale().id, customer.id))
    ok(h.customers.saveCustomer(h.manager, { id: customer.id, name: 'Autre nom', companyName: 'Nouvelle SARL', address: 'Ailleurs' }))
    expect(ok(h.invoices.listInvoices(h.manager, [invoice.ticketId]))[0]!.customer.companyName).toBe('Alaoui SARL')
    expect(() => h.t.db.prepare("UPDATE invoices SET customer_json = '{}' WHERE id = ?").run(invoice.id)).toThrow(/invoice_immutable/)
    expect(() => h.t.db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id)).toThrow(/invoice_immutable/)
  })

  it('lists the invoices of the given tickets, newest first', () => {
    const customer = company()
    const a = ok(h.invoices.createInvoice(h.manager, sale().id, customer.id))
    h.clock.advance(1000)
    const b = ok(h.invoices.createInvoice(h.manager, sale().id, customer.id))
    expect(ok(h.invoices.listInvoices(h.cashier)).map((i) => i.numberLabel)).toEqual([b.numberLabel, a.numberLabel])
    expect(ok(h.invoices.listInvoices(h.cashier, [a.ticketId])).map((i) => i.numberLabel)).toEqual([a.numberLabel])
    expect(ok(h.invoices.listInvoices(h.cashier, []))).toEqual([])
  })

  it('invoicePdf renders the A4 page of the stored row and names the file after the number', async () => {
    const invoice = ok(h.invoices.createInvoice(h.manager, sale().id, company().id))
    const pdf = ok(await h.invoices.invoicePdf(h.manager, invoice.id))
    expect(pdf.fileName).toBe('F-2026-00001.pdf')
    expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe('%PDF')
    expect(h.pdfs).toHaveLength(1)
    expect(h.pdfs[0]).toContain('F-2026-00001')
    expect(h.pdfs[0]).toContain('Alaoui SARL')
    expect(h.pdfs[0]).toContain('002233445000011')
    expect(code(await h.invoices.invoicePdf(h.cashier, invoice.id))).toBe('forbidden')
    expect(code(await h.invoices.invoicePdf(h.manager, 'nope'))).toBe('invalid_input')
  })

  it('printInvoice queues the job on a printer that takes documents, and refuses a thermal one up front', () => {
    const invoice = ok(h.invoices.createInvoice(h.manager, sale().id, company().id))
    addPrinter(h.t.db, { id: 'p-a4', name: 'Bureau', kind: 'os-html', address: 'HP', role: 'receipt' })
    addPrinter(h.t.db, { id: 'p-net', name: 'Réseau', kind: 'network', address: '127.0.0.1:9100', role: 'receipt' })
    const before = h.spooler.jobs().length
    expect(code(h.invoices.printInvoice(h.manager, invoice.id, 'p-net'))).toBe('printer_not_a4')
    expect(code(h.invoices.printInvoice(h.manager, invoice.id, 'nope'))).toBe('invalid_input')
    expect(code(h.invoices.printInvoice(h.cashier, invoice.id, 'p-a4'))).toBe('forbidden')
    expect(h.spooler.jobs()).toHaveLength(before)
    ok(h.invoices.printInvoice(h.manager, invoice.id, 'p-a4'))
    expect(h.spooler.jobs().slice(before)).toEqual([{ target: { printerId: 'p-a4' }, kind: 'invoice', payload: { invoiceId: invoice.id } }])
  })
})
