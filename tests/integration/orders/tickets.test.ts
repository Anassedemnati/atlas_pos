import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderDto } from '../../../src/shared/dto'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'

describe('tickets: credits, reprints, split', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const add = (orderId: string, productId: string, qtyMilli = 1000): OrderDto =>
    ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli, modifierIds: [], note: '' }))

  /** T4: 2 tajines, a couscous, 3 teas (271,00 DH), paid by card 100,00 and cash 171,00 (200,00 handed over). */
  const restaurantTicket = () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    add(order.id, h.fx.products.tajine, 2000)
    add(order.id, h.fx.products.couscous)
    add(order.id, h.fx.products.the, 3000)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 10000 }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 20000 }))
    return ok(h.tickets.closeOrder(h.cashier, order.id))
  }

  it('cancel: a credit note AV-000001 with the amounts negated, referencing the original; the X report nets to 0', () => {
    const sale = restaurantTicket()
    const credit = ok(h.tickets.cancelTicket(h.manager, sale.id, 'Client parti'))
    expect(credit).toMatchObject({
      kind: 'credit',
      number: 1,
      label: 'AV-000001',
      refTicketId: sale.id,
      orderId: sale.orderId,
      dayId: sale.dayId,
      totalCents: -27100
    })
    const s = credit.snapshot
    expect(s.ref).toEqual({ ticketId: sale.id, label: '000001', reason: 'Client parti' })
    expect(s.totals).toEqual({ grossCents: -27100, lineDiscountsCents: 0, ticketDiscountCents: 0, totalCents: -27100 })
    expect(s.vat).toEqual(sale.snapshot.vat.map((r) => ({ rateBp: r.rateBp, ttc: -r.ttc, ht: -r.ht, vat: -r.vat })))
    expect(s.lines.map((l) => l.netCents)).toEqual(sale.snapshot.lines.map((l) => -l.netCents))
    expect(s.payments.map((p) => [p.methodCode, p.amountCents])).toEqual([
      ['card', -10000],
      ['cash', -17100]
    ])
    expect(s.user).toEqual({ id: h.manager.userId, displayName: 'Amine Benali' })
    expect(h.published).toContainEqual({ type: 'ticket.closed', ticketId: credit.id })

    const x = ok(h.days.xReport(h.cashier))
    expect(x).toMatchObject({
      zNumber: null,
      closedAt: null,
      ticketsCount: 1,
      creditsCount: 1,
      grossCents: 0,
      discountsCents: 0,
      totalCents: 0
    })
    expect(x.byPayment.map((p) => [p.methodCode, p.cents])).toEqual([
      ['card', 0],
      ['cash', 0]
    ])
    expect(x.byVat.every((r) => r.ttc === 0 && r.ht === 0 && r.vat === 0)).toBe(true)
  })

  it('cancel needs ticket.cancel and a reason; a ticket is cancelled once; a credit cannot be cancelled', () => {
    const sale = restaurantTicket()
    expect(h.tickets.cancelTicket(h.cashier, sale.id, 'x')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'ticket.cancel' } }
    })
    expect(code(h.tickets.cancelTicket(h.manager, sale.id, '  '))).toBe('invalid_input')
    const credit = ok(h.tickets.cancelTicket(h.manager, sale.id, 'Erreur'))
    expect(code(h.tickets.cancelTicket(h.manager, sale.id, 'Erreur'))).toBe('already_cancelled')
    expect(code(h.tickets.cancelTicket(h.manager, credit.id, 'Erreur'))).toBe('not_a_sale')
    expect(h.count('tickets', "kind = 'credit'")).toBe(1)
  })

  it('a cancellation after the Z counts in the new business day', () => {
    const sale = restaurantTicket()
    ok(h.days.closeDay(h.manager))
    const credit = ok(h.tickets.cancelTicket(h.manager, sale.id, 'Erreur'))
    expect(credit.dayId).not.toBe(sale.dayId)
    expect(credit.snapshot.dayNumber).toBe(2)
    expect(ok(h.days.xReport(h.cashier))).toMatchObject({ dayNumber: 2, ticketsCount: 0, creditsCount: 1, totalCents: -27100 })
  })

  it('reprint: counter + 1, a DUPLICATA job, the ticket itself unchanged', () => {
    const sale = restaurantTicket()
    expect(code(h.tickets.reprintTicket(h.waiter, sale.id))).toBe('forbidden')
    const again = ok(h.tickets.reprintTicket(h.cashier, sale.id))
    expect(again.reprintCount).toBe(1)
    expect(again.snapshot).toEqual(sale.snapshot)
    expect(h.spooler.jobs().at(-1)).toEqual({
      target: { role: 'receipt' },
      kind: 'receipt',
      payload: { ticketId: sale.id, duplicate: true }
    })
    ok(h.tickets.reprintTicket(h.cashier, sale.id))
    expect(ok(h.days.xReport(h.cashier)).reprints).toBe(2)
  })

  it('a reprint after the Z opens the next day, whose Z counts it', () => {
    const sale = restaurantTicket()
    ok(h.days.closeDay(h.manager))
    ok(h.tickets.reprintTicket(h.cashier, sale.id))
    expect(ok(h.days.xReport(h.cashier))).toMatchObject({ dayNumber: 2, reprints: 1, ticketsCount: 0 })
  })

  it('splitAndClose: one ticket per group, the groups adding up to the bill, the rest staying on the table', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
    add(order.id, h.fx.products.tajine, 2000)
    add(order.id, h.fx.products.couscous)
    const dto = add(order.id, h.fx.products.the, 3000)
    ok(h.orders.setTicketDiscount(h.manager, order.id, { kind: 'amount', cents: 1000, reason: 'Geste commercial' }))
    const [tajine, couscous, the] = dto.lines.map((l) => l.id) as [string, string, string]

    const tickets = ok(
      h.tickets.splitAndClose(h.cashier, order.id, [
        { lineIds: [tajine], payments: [{ methodCode: 'card', amountCents: 13483 }] },
        { lineIds: [couscous], payments: [{ methodCode: 'cash', amountCents: 10000 }] }
      ])
    )
    expect(tickets.map((t) => t.label)).toEqual(['000001', '000002'])
    // Every payment of a split has its audit row, on the part it paid.
    expect(h.eventRows('payment.added').map((e) => [e.entity_id, (e.data as { amountCents: number }).amountCents])).toEqual([
      [tickets[0]!.orderId, 13483],
      [tickets[1]!.orderId, 9150]
    ])
    expect(tickets.map((t) => t.totalCents)).toEqual([13483, 9150])
    expect(tickets[1]!.snapshot.changeCents).toBe(850)
    const rest = ok(h.orders.getOrder(h.cashier, order.id))
    expect(rest.status).toBe('open')
    expect(rest.lines.filter((l) => l.status === 'active').map((l) => l.id)).toEqual([the])
    // The ticket discount was shared once: what is left plus the two tickets is the discounted bill.
    expect(rest.totals.totalCents + 13483 + 9150).toBe(27100 - 1000)

    const last = ok(h.tickets.splitAndClose(h.cashier, order.id, [{ lineIds: [the], payments: [{ methodCode: 'card', amountCents: rest.totals.totalCents }] }]))
    expect(last[0]!.label).toBe('000003')
    expect(ok(h.orders.getOrder(h.cashier, order.id)).status).toBe('cancelled')
  })

  it('splitAndClose is all or nothing: a group left unpaid closes none', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
    add(order.id, h.fx.products.tajine)
    const dto = add(order.id, h.fx.products.couscous)
    const [a, b] = dto.lines.map((l) => l.id) as [string, string]
    const r = h.tickets.splitAndClose(h.cashier, order.id, [
      { lineIds: [a], payments: [{ methodCode: 'card', amountCents: 7000 }] },
      { lineIds: [b], payments: [{ methodCode: 'card', amountCents: 100 }] }
    ])
    expect(code(r)).toBe('not_paid')
    expect(code(h.tickets.splitAndClose(h.cashier, order.id, []))).toBe('invalid_input')
    expect(code(h.tickets.splitAndClose(h.cashier, order.id, [{ lineIds: [a, a], payments: [] }]))).toBe('invalid_split')
    expect(h.count('tickets')).toBe(0)
    expect(h.count('orders')).toBe(1)
    expect(h.count('payments')).toBe(0)
  })

  it('tickets cannot be changed or deleted in the database (immutability triggers)', () => {
    const sale = restaurantTicket()
    expect(() => h.t.db.prepare('UPDATE tickets SET total_cents = 1 WHERE id = ?').run(sale.id)).toThrow(/ticket_immutable/)
  })
})
