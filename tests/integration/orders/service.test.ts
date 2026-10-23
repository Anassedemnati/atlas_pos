import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderDto, TicketDto } from '../../../src/shared/dto'
import { computeTotals } from '../../../src/main/domain/order/totals'
import { resetSequence } from '../../../src/main/infrastructure/db/sequences'
import { code, LEGAL, ok, salesHarness, type SalesHarness } from '../../helpers/sales'

describe('orders: a full service', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const add = (orderId: string, productId: string, qtyMilli = 1000, over: Record<string, unknown> = {}): OrderDto =>
    ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli, modifierIds: [], note: '', ...over }))

  it('restaurant: open T4, add lines, send, pay mixed, close -> ticket 000001 whose snapshot is the computed bill', () => {
    const opened = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    expect(opened).toMatchObject({ status: 'open', tableLabel: 'T4', covers: 2, orderNumber: null, lines: [] })
    // The first sale opened business day 1.
    expect(ok(h.days.currentDay(h.cashier))).toMatchObject({ number: 1, closedAt: null })

    add(opened.id, h.fx.products.tajine, 2000)
    add(opened.id, h.fx.products.couscous)
    const before = add(opened.id, h.fx.products.the, 3000)
    expect(before.totals.totalCents).toBe(27100)
    expect(before.lines.map((l) => l.name.fr)).toEqual(['Tajine', 'Couscous', 'Thé à la menthe'])

    const sent = ok(h.orders.sendToKitchen(h.cashier, opened.id))
    expect(sent.lines.every((l) => l.sentAt !== null)).toBe(true)
    expect(h.published).toContainEqual({ type: 'order.sent', orderId: opened.id, lineIds: sent.lines.map((l) => l.id) })
    expect(h.spooler.jobs()).toContainEqual({
      target: { role: 'kitchen' },
      kind: 'kitchen',
      payload: { orderId: opened.id, lineIds: sent.lines.map((l) => l.id) }
    })

    ok(h.orders.addPayment(h.cashier, opened.id, { methodCode: 'card', amountCents: 10000 }))
    // Cash: 200,00 DH handed over for the 171,00 DH still due.
    const paid = ok(h.orders.addPayment(h.cashier, opened.id, { methodCode: 'cash', amountCents: 20000 }))
    expect(paid.payments.map((p) => [p.methodCode, p.amountCents, p.tenderedCents])).toEqual([
      ['card', 10000, 10000],
      ['cash', 17100, 20000]
    ])
    expect(paid).toMatchObject({ paidCents: 27100, dueCents: 0, changeCents: 2900 })

    const ticket = ok(h.tickets.closeOrder(h.cashier, opened.id))
    expect(ticket).toMatchObject({ kind: 'sale', number: 1, label: '000001', totalCents: 27100, refTicketId: null })
    const snap = ticket.snapshot
    const expected = computeTotals(paid.lines, paid.discount)
    expect(snap.totals.totalCents).toBe(expected.total)
    expect(snap.lines.reduce((s, l) => s + l.netCents, 0)).toBe(27100)
    expect(snap.vat).toEqual(expected.vat)
    expect(snap).toMatchObject({
      kind: 'sale',
      label: '000001',
      number: 1,
      dayNumber: 1,
      business: LEGAL,
      order: { type: 'dine_in', table: { label: 'T4' }, covers: 2, number: null },
      user: { id: h.cashier.userId, displayName: 'Sara El Idrissi' },
      paidCents: 27100,
      changeCents: 2900,
      customer: null
    })
    expect(snap.lines[0]).toMatchObject({
      name: { fr: 'Tajine', ar: 'طاجين', en: 'Tagine' },
      categoryName: { fr: 'Plats' },
      qtyMilli: 2000,
      grossCents: 14000,
      netCents: 14000
    })
    expect(snap.payments).toEqual([
      { methodCode: 'card', methodName: { fr: 'Carte bancaire' }, amountCents: 10000, tenderedCents: 10000 },
      { methodCode: 'cash', methodName: { fr: 'Espèces' }, amountCents: 17100, tenderedCents: 20000 }
    ])

    const order = ok(h.orders.getOrder(h.cashier, opened.id))
    expect(order.status).toBe('closed')
    expect(h.published).toContainEqual({ type: 'ticket.closed', ticketId: ticket.id })
    const kinds = h.spooler.jobs().map((j) => j.kind)
    expect(kinds).toEqual(['kitchen', 'receipt', 'drawer'])
    // A closed ticket is a legal record: changes to its order are refused.
    expect(code(h.orders.addLine(h.cashier, opened.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))).toBe(
      'order_not_open'
    )
  })

  it('refuses to close while something is due, and the ticket counter does not move', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    add(order.id, h.fx.products.the)
    expect(h.tickets.closeOrder(h.cashier, order.id)).toMatchObject({ ok: false, error: { code: 'not_paid', params: { dueCents: 1200 } } })
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 1200 }))
    expect(ok(h.tickets.closeOrder(h.cashier, order.id)).label).toBe('000001')
  })

  it('opening an occupied table returns the order already on it', () => {
    const first = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
    const again = ok(h.orders.openOrder(h.manager, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 4 }))
    expect(again.id).toBe(first.id)
    expect(h.count('orders')).toBe(1)
  })

  it('every mutation writes one event_log row and pushes order.changed', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    const line = add(order.id, h.fx.products.the).lines[0]!
    ok(h.orders.setLineQty(h.cashier, order.id, line.id, 2000))
    ok(h.orders.setNote(h.cashier, order.id, 'sans sucre'))
    ok(h.orders.setCovers(h.cashier, order.id, 3))
    const types = h.eventRows().filter((e) => e.entity === 'order').map((e) => e.type)
    expect(types).toEqual(['order.opened', 'order.line_added', 'order.line_qty', 'order.note', 'order.covers'])
    expect(h.published.filter((e) => e.type === 'order.changed')).toHaveLength(5)
  })

  it('snapshots the line: price and VAT stay as sold when the catalogue changes', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    add(order.id, h.fx.products.the)
    h.t.db.prepare('UPDATE products SET price_cents = 9999, vat_bp = 0 WHERE id = ?').run(h.fx.products.the)
    const after = ok(h.orders.getOrder(h.cashier, order.id))
    expect(after.lines[0]).toMatchObject({ unitPriceCents: 1200, vatBp: 2000 })
  })

  it('weight items: 0,350 kg of bread at 60,00 DH/kg is 21,00 DH; a unit product refuses a fraction', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    expect(add(order.id, h.fx.products.pain, 350).totals.totalCents).toBe(2100)
    expect(code(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 500, modifierIds: [], note: '' }))).toBe(
      'invalid_qty'
    )
  })

  it('modifiers: priced and checked against the product groups (min / max)', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t5 }))
    const { brochettes } = h.fx.products
    const { saignant, bienCuit } = h.fx.modifiers
    const withMod = add(order.id, brochettes, 1000, { modifierIds: [bienCuit] })
    expect(withMod.lines[0]!.modifiers).toEqual([{ id: bienCuit, name: { fr: 'Bien cuit' }, priceDeltaCents: 200 }])
    expect(withMod.totals.totalCents).toBe(8200)
    const line = (modifierIds: string[]) => h.orders.addLine(h.cashier, order.id, { productId: brochettes, qtyMilli: 1000, modifierIds, note: '' })
    expect(code(line([]))).toBe('invalid_modifiers')
    expect(code(line([saignant, bienCuit]))).toBe('invalid_modifiers')
    expect(code(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [saignant], note: '' }))).toBe(
      'invalid_modifiers'
    )
  })

  it('set menu: the choice is on the line with its supplement', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    const dto = add(order.id, h.fx.products.menu, 1000, {
      menuChoices: [{ courseId: h.fx.menu.courseId, productIds: [h.fx.products.couscous] }]
    })
    expect(dto.lines[0]!.modifiers).toEqual([
      { id: h.fx.products.couscous, name: { fr: 'Couscous' }, priceDeltaCents: 500, menuCourseId: h.fx.menu.courseId }
    ])
    expect(dto.totals.totalCents).toBe(12500)
    expect(code(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.menu, qtyMilli: 1000, modifierIds: [], note: '' }))).toBe(
      'invalid_menu_choice'
    )
  })

  it('stock: a sale decrements a tracked product, a void and a cancellation restore it', () => {
    const { eau } = h.fx.products
    expect(h.stockOf(eau)).toBe(10000)
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    const line = add(order.id, eau, 3000).lines[0]!
    expect(h.stockOf(eau)).toBe(7000)
    ok(h.orders.setLineQty(h.cashier, order.id, line.id, 2000))
    expect(h.stockOf(eau)).toBe(8000)
    ok(h.orders.voidLine(h.cashier, order.id, line.id, ''))
    expect(h.stockOf(eau)).toBe(10000)

    add(order.id, eau, 2000)
    expect(h.stockOf(eau)).toBe(8000)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1500 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(h.stockOf(eau)).toBe(8000)
    ok(h.tickets.cancelTicket(h.manager, ticket.id, 'Erreur de saisie'))
    expect(h.stockOf(eau)).toBe(10000)
  })

  it('café: order numbers count from 1 per business day, wrap after 999, and reset when a new day opens', () => {
    h.uow.run((tx) => h.settings.set(tx, 'business.type', 'cafe'))
    const sale = (type: 'counter' | 'takeaway' | 'dine_in'): { order: OrderDto; ticket: TicketDto } => {
      const order = ok(h.orders.openOrder(h.cashier, { type }))
      add(order.id, h.fx.products.the)
      ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
      return { order, ticket: ok(h.tickets.closeOrder(h.cashier, order.id)) }
    }
    expect(sale('counter').order.orderNumber).toBe(1)
    const second = sale('takeaway')
    expect(second.order.orderNumber).toBe(2)
    expect(second.ticket.snapshot.order.number).toBe(2)
    // Sur place at a café table has no counter number.
    expect(sale('dine_in').order.orderNumber).toBeNull()

    h.uow.run((tx) => resetSequence(tx.db, 'order-number', 998))
    expect(sale('counter').order.orderNumber).toBe(999)
    expect(sale('counter').order.orderNumber).toBe(1)

    ok(h.days.closeDay(h.manager))
    h.clock.advance(60_000)
    const nextDay = sale('counter')
    expect(nextDay.order.orderNumber).toBe(1)
    expect(ok(h.days.currentDay(h.cashier))).toMatchObject({ number: 2 })
    // Ticket numbers never reset.
    expect(nextDay.ticket.label).toBe('000006')
  })

  it('a restaurant gives no order number', () => {
    expect(ok(h.orders.openOrder(h.cashier, { type: 'counter' })).orderNumber).toBeNull()
  })

  it('closing sends what the kitchen has not received yet (a counter sale never pressed "send")', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    const lineId = add(order.id, h.fx.products.tajine).lines[0]!.id
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(h.published).toContainEqual({ type: 'order.sent', orderId: order.id, lineIds: [lineId] })
    expect(h.spooler.jobs().map((j) => j.kind)).toEqual(['kitchen', 'receipt'])
  })

  it('a refused mutation writes nothing (the transaction rolls back)', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    const rows = h.count('event_log')
    expect(code(h.orders.addLine(h.cashier, order.id, { productId: 'nope', qtyMilli: 1000, modifierIds: [], note: '' }))).toBe(
      'invalid_input'
    )
    expect(h.count('event_log')).toBe(rows)
    expect(h.count('order_lines')).toBe(0)
  })

  it('openOrder refuses while the previous day must be closed', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    h.clock.advance(25 * 3600_000)
    expect(code(h.orders.openOrder(h.cashier, { type: 'counter' }))).toBe('day_must_close')
    // The order already open can still be finished.
    add(order.id, h.fx.products.the)
  })
})
