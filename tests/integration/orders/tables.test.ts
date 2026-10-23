import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderDto } from '../../../src/shared/dto'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'

describe('orders: kitchen courses, parking, tables, customers', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const open = (tableId: string): OrderDto => ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId }))
  const add = (orderId: string, productId: string, over: Record<string, unknown> = {}): OrderDto =>
    ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli: 1000, modifierIds: [], note: '', ...over }))
  const sentNames = (dto: OrderDto): string[] => dto.lines.filter((l) => l.sentAt !== null).map((l) => l.name.fr)

  it('courses: send takes the drinks and the first course, send next course the next one', () => {
    const { the, salade, brochettes, cornes } = h.fx.products
    const order = open(h.fx.tables.t4)
    add(order.id, the)
    add(order.id, salade)
    add(order.id, brochettes, { modifierIds: [h.fx.modifiers.saignant] })
    add(order.id, cornes)
    expect(sentNames(ok(h.orders.sendToKitchen(h.cashier, order.id)))).toEqual(['Thé à la menthe', 'Salade'])
    expect(code(h.orders.sendToKitchen(h.cashier, order.id))).toBe('nothing_to_send')
    // A second salad ordered later goes with "send": its course is already fired.
    add(order.id, salade)
    expect(sentNames(ok(h.orders.sendToKitchen(h.cashier, order.id)))).toEqual(['Thé à la menthe', 'Salade', 'Salade'])
    expect(sentNames(ok(h.orders.sendNextCourse(h.cashier, order.id)))).toContain('Brochettes')
    const last = ok(h.orders.sendNextCourse(h.cashier, order.id))
    expect(sentNames(last)).toHaveLength(5)
    expect(code(h.orders.sendNextCourse(h.cashier, order.id))).toBe('nothing_to_send')
    const sent = h.published.filter((e) => e.type === 'order.sent')
    expect(sent).toHaveLength(4)
  })

  it('park and resume: a parked order takes no change until resumed', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    expect(ok(h.orders.parkOrder(h.cashier, order.id)).status).toBe('parked')
    expect(code(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))).toBe(
      'order_not_open'
    )
    expect(ok(h.orders.resumeOrder(h.cashier, order.id)).status).toBe('open')
    add(order.id, h.fx.products.the)
  })

  it('transfer to a free table; an occupied one is refused', () => {
    const a = open(h.fx.tables.t4)
    open(h.fx.tables.t5)
    expect(code(h.orders.transferTable(h.cashier, a.id, h.fx.tables.t5))).toBe('table_occupied')
    const moved = ok(h.orders.transferTable(h.cashier, a.id, h.fx.tables.t6))
    expect(moved).toMatchObject({ tableId: h.fx.tables.t6, tableLabel: 'T6' })
    // T4 is free again.
    expect(open(h.fx.tables.t4).id).not.toBe(a.id)
  })

  it('merge: lines, payments and covers go to the other table; the merged order is cancelled', () => {
    const a = open(h.fx.tables.t4)
    ok(h.orders.setCovers(h.cashier, a.id, 2))
    add(a.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, a.id, { methodCode: 'card', amountCents: 2000 }))
    const b = open(h.fx.tables.t5)
    ok(h.orders.setCovers(h.cashier, b.id, 3))
    add(b.id, h.fx.products.the)
    const merged = ok(h.orders.mergeTables(h.cashier, a.id, b.id))
    expect(merged.lines.map((l) => [l.seq, l.name.fr])).toEqual([
      [1, 'Thé à la menthe'],
      [2, 'Tajine']
    ])
    expect(merged).toMatchObject({ covers: 5, paidCents: 2000, dueCents: 6200 })
    expect(ok(h.orders.getOrder(h.cashier, a.id))).toMatchObject({ status: 'cancelled', lines: [], payments: [] })
  })

  it('merge is refused (below_paid) when the target discount takes the merged bill under what was paid', () => {
    const a = open(h.fx.tables.t4)
    add(a.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, a.id, { methodCode: 'card', amountCents: 7000 }))
    const b = open(h.fx.tables.t5)
    add(b.id, h.fx.products.the)
    ok(h.orders.setTicketDiscount(h.manager, b.id, { kind: 'pct', bp: 5000, reason: 'Geste commercial' }))
    expect(code(h.orders.mergeTables(h.cashier, a.id, b.id))).toBe('below_paid')
    expect(ok(h.orders.getOrder(h.cashier, a.id))).toMatchObject({ status: 'open', paidCents: 7000 })
    expect(ok(h.orders.getOrder(h.cashier, a.id)).lines).toHaveLength(1)
    expect(ok(h.orders.getOrder(h.cashier, b.id)).payments).toEqual([])
  })

  it('move lines between orders; refused when it would leave the source below what it was paid', () => {
    const a = open(h.fx.tables.t4)
    add(a.id, h.fx.products.tajine)
    const dto = add(a.id, h.fx.products.the)
    const b = open(h.fx.tables.t5)
    const moved = ok(h.orders.moveLines(h.cashier, a.id, [dto.lines[1]!.id], b.id))
    expect(moved.id).toBe(a.id)
    expect(ok(h.orders.getOrder(h.cashier, b.id)).lines.map((l) => l.name.fr)).toEqual(['Thé à la menthe'])
    ok(h.orders.addPayment(h.cashier, a.id, { methodCode: 'card', amountCents: 7000 }))
    expect(code(h.orders.moveLines(h.cashier, a.id, [dto.lines[0]!.id], b.id))).toBe('below_paid')
    expect(code(h.orders.moveLines(h.cashier, a.id, ['nope'], b.id))).toBe('invalid_input')
  })

  it('customers: saved, searched, assigned; a company needs a 15-digit ICE', () => {
    expect(code(h.customers.saveCustomer(h.cashier, { name: 'Atlas Voyages', isCompany: true, companyName: 'Atlas Voyages SARL', ice: '123' }))).toBe(
      'invalid_input'
    )
    const c = ok(
      h.customers.saveCustomer(h.cashier, {
        name: 'Atlas Voyages',
        isCompany: true,
        companyName: 'Atlas Voyages SARL',
        ice: '001122334455667',
        phone: '0600000000'
      })
    )
    ok(h.customers.saveCustomer(h.cashier, { name: 'Karim' }))
    expect(ok(h.customers.searchCustomers(h.cashier, 'voyag')).map((x) => x.id)).toEqual([c.id])
    expect(ok(h.customers.searchCustomers(h.cashier, '0600')).map((x) => x.id)).toEqual([c.id])
    const edited = ok(h.customers.saveCustomer(h.cashier, { id: c.id, name: 'Atlas Voyages', isCompany: false }))
    expect(edited).toMatchObject({ id: c.id, isCompany: false, phone: '0600000000' })

    const order = ok(h.orders.openOrder(h.cashier, { type: 'delivery', customerId: c.id }))
    expect(order.customerId).toBe(c.id)
    add(order.id, h.fx.products.the)
    expect(code(h.orders.assignCustomer(h.cashier, order.id, 'nope'))).toBe('invalid_input')
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 1200 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(ticket.snapshot.customer).toMatchObject({ id: c.id, name: 'Atlas Voyages', phone: '0600000000' })
  })
})
