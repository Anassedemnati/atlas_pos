import { afterEach, describe, expect, it } from 'vitest'
import type { OrderDto, ZData } from '../../../src/shared/dto'
import { code, local, ok, salesHarness, type SalesHarness } from '../../helpers/sales'

describe('business day, X and Z', () => {
  let h: SalesHarness
  afterEach(() => h.cleanup())

  const add = (orderId: string, productId: string, qtyMilli = 1000): OrderDto =>
    ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli, modifierIds: [], note: '' }))
  const paidSale = (lines: [string, number][], method = 'cash'): string => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    let dto: OrderDto = order
    for (const [productId, qty] of lines) dto = add(order.id, productId, qty)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: method, amountCents: dto.totals.totalCents }))
    return ok(h.tickets.closeOrder(h.cashier, order.id)).id
  }

  it('no day is open before the first sale; the first sale opens day 1', () => {
    h = salesHarness()
    expect(ok(h.days.currentDay(h.cashier))).toBeNull()
    expect(ok(h.days.dayGate(h.cashier))).toEqual({ state: 'ok', dayNumber: 1, openedAt: null })
    expect(code(h.days.xReport(h.cashier))).toBe('no_open_day')
    expect(code(h.days.closeDay(h.manager))).toBe('no_open_day')
    ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    expect(ok(h.days.currentDay(h.cashier))).toMatchObject({ number: 1, openedAt: local(10, 22, 11) })
  })

  it('closeDay with an open order is refused with open_orders_exist and the list of orders', () => {
    h = salesHarness()
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
    add(order.id, h.fx.products.the)
    const r = h.days.closeDay(h.manager)
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'open_orders_exist', params: { orders: [{ id: order.id, type: 'dine_in', tableLabel: 'T4', totalCents: 1200 }] } }
    })
    expect(h.count('z_reports')).toBe(0)
    expect(h.backups).toEqual([])
    expect(ok(h.days.currentDay(h.cashier))?.closedAt).toBeNull()
  })

  it('an empty order left open does not block the Z: it is cancelled with it', () => {
    h = salesHarness()
    paidSale([[h.fx.products.the, 1000]])
    const empty = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t5 }))
    ok(h.days.closeDay(h.manager))
    expect(ok(h.orders.getOrder(h.cashier, empty.id)).status).toBe('cancelled')
  })

  it('closeDay needs day.close', () => {
    h = salesHarness()
    paidSale([[h.fx.products.the, 1000]])
    expect(h.days.closeDay(h.cashier)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'day.close' } } })
  })

  it('Z: stores the immutable report, closes the day, emits day.closed, prints it and asks for a full backup', () => {
    h = salesHarness()
    const { tajine, the, eau } = h.fx.products
    paidSale([
      [tajine, 2000],
      [the, 3000]
    ])
    // A discounted sale by card, with a free water: 70,00 - 10 % = 63,00, water offered (7,50).
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    add(order.id, tajine)
    const withWater = add(order.id, eau)
    ok(h.orders.setLineDiscount(h.cashier, order.id, withWater.lines[0]!.id, { kind: 'pct', bp: 1000, reason: 'Client fidèle' }))
    ok(h.orders.setFree(h.manager, order.id, withWater.lines[1]!.id, true, 'Geste commercial'))
    const voided = add(order.id, the)
    ok(h.orders.voidLine(h.cashier, order.id, voided.lines[2]!.id, ''))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 6300 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))

    h.clock.advance(3600_000)
    const z = ok(h.days.closeDay(h.manager))
    const data: ZData = z.data
    expect(data).toMatchObject({
      dayNumber: 1,
      zNumber: 1,
      openedAt: local(10, 22, 11),
      closedAt: local(10, 22, 12),
      ticketsCount: 2,
      creditsCount: 0,
      grossCents: 17600 + 7000 + 750,
      discountsCents: 700,
      totalCents: 17600 + 6300,
      voids: { count: 1, cents: 1200 },
      freeItems: { count: 1, cents: 750 },
      reprints: 0
    })
    expect(data.grossCents - data.discountsCents - data.freeItems.cents).toBe(data.totalCents)
    expect(data.byPayment).toEqual([
      { methodCode: 'card', name: { fr: 'Carte bancaire' }, count: 1, cents: 6300 },
      { methodCode: 'cash', name: { fr: 'Espèces' }, count: 1, cents: 17600 }
    ])
    expect(data.byVat.reduce((s, r) => s + r.ttc, 0)).toBe(data.totalCents)
    expect(data.byCategory).toEqual([
      { categoryId: h.fx.categories.plats, name: { fr: 'Plats' }, qtyMilli: 3000, cents: 14000 + 6300 },
      { categoryId: h.fx.categories.boissons, name: { fr: 'Boissons' }, qtyMilli: 4000, cents: 3600 }
    ])
    expect(data.byUser).toEqual([{ userId: h.cashier.userId, displayName: 'Sara El Idrissi', ticketsCount: 2, cents: 23900 }])

    const row = h.t.db.prepare('SELECT * FROM z_reports').get() as { id: string; number: number; data_json: string; user_id: string }
    expect(row).toMatchObject({ id: z.zId, number: 1, user_id: h.manager.userId })
    expect(JSON.parse(row.data_json)).toEqual(data)
    expect(() => h.t.db.prepare('DELETE FROM z_reports').run()).toThrow(/z_report_immutable/)
    expect(ok(h.days.currentDay(h.cashier))).toBeNull()
    expect(h.published).toContainEqual({ type: 'day.closed', dayId: (h.t.db.prepare('SELECT id FROM business_days').get() as { id: string }).id, zId: z.zId })
    expect(h.spooler.jobs().at(-1)).toEqual({ target: { role: 'receipt' }, kind: 'z', payload: { zId: z.zId } })
    expect(h.backups).toEqual(['Z1'])

    // The X of a closed day is its stored Z.
    const dayId = (h.t.db.prepare('SELECT id FROM business_days').get() as { id: string }).id
    expect(ok(h.days.xReport(h.cashier, dayId))).toEqual(data)
  })

  it('Z: no full backup when backup.onClose is off', () => {
    h = salesHarness()
    h.uow.run((tx) => h.settings.set(tx, 'backup.onClose', false))
    paidSale([[h.fx.products.the, 1000]])
    ok(h.days.closeDay(h.manager))
    expect(h.backups).toEqual([])
  })

  it('a second Z the same calendar date gets the next numbers', () => {
    h = salesHarness()
    paidSale([[h.fx.products.the, 1000]])
    ok(h.days.closeDay(h.manager))
    h.clock.advance(60_000)
    paidSale([[h.fx.products.the, 1000]])
    const z = ok(h.days.closeDay(h.manager))
    expect(z.data).toMatchObject({ dayNumber: 2, zNumber: 2, ticketsCount: 1 })
    expect(h.backups).toEqual(['Z1', 'Z2'])
  })

  describe('dayGate', () => {
    it('is ok during the day and must_close once the cut-over hour (05:00) has passed', () => {
      h = salesHarness(local(10, 22, 11))
      ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      expect(ok(h.days.dayGate(h.cashier))).toEqual({ state: 'ok', dayNumber: 1, openedAt: local(10, 22, 11) })
      h.clock.advance((17 * 60 + 59) * 60_000) // 04:59 the next morning
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('ok')
      h.clock.advance(60_000) // 05:00
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('must_close')
    })

    it('a day opened after midnight but before the cut-over must close at the cut-over of that same date', () => {
      h = salesHarness(local(10, 23, 2))
      ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      h.clock.advance(2 * 3600_000 + 59 * 60_000)
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('ok')
      h.clock.advance(60_000)
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('must_close')
    })

    it('follows the day.cutoverHour setting', () => {
      h = salesHarness(local(10, 22, 11))
      h.uow.run((tx) => h.settings.set(tx, 'day.cutoverHour', 12))
      ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      h.clock.advance(3600_000)
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('must_close')
    })

    it('must_close after 24 h open even with the cut-over at the opening hour', () => {
      h = salesHarness(local(10, 22, 5))
      ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      h.clock.advance(24 * 3600_000 - 60_000)
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('ok')
      h.clock.advance(120_000)
      expect(ok(h.days.dayGate(h.cashier)).state).toBe('must_close')
    })
  })
})
