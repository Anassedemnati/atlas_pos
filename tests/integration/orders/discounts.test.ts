import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderDto } from '../../../src/shared/dto'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'
import { PINS } from '../../helpers/users'

describe('orders: discounts, free items, voids, payments', () => {
  let h: SalesHarness
  let order: OrderDto
  let lineId: string
  beforeEach(() => {
    h = salesHarness()
    order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
    lineId = ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.tajine, qtyMilli: 1000, modifierIds: [], note: '' }))
      .lines[0]!.id
  })
  afterEach(() => h.cleanup())

  const pct = (bp: number) => ({ kind: 'pct' as const, bp, reason: 'Client fidèle' })

  it('a discount within the profile limit applies and is logged', () => {
    const dto = ok(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(1000)))
    expect(dto.totals.totalCents).toBe(6300)
    expect(h.eventRows('order.discount').at(-1)).toMatchObject({ user_id: h.cashier.userId, data: { lineId, discount: pct(1000) } })
  })

  it('above the limit it needs a manager override token, which is spent and logged as overriddenBy', async () => {
    expect(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(2000))).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.discount.override' } }
    })
    const token = ok(await h.users.authorizeOverride(PINS.amine, 'order.discount.override'))
    const dto = ok(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(2000), token))
    expect(dto.totals.totalCents).toBe(5600)
    expect(h.eventRows('order.discount').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
    // One use only.
    expect(code(h.orders.setTicketDiscount(h.cashier, order.id, pct(2000), token))).toBe('forbidden')
  })

  it('an amount discount is measured against the base: 7,01 DH off 70,00 is over 10 %', () => {
    expect(code(h.orders.setLineDiscount(h.cashier, order.id, lineId, { kind: 'amount', cents: 701, reason: 'x' }))).toBe('forbidden')
    expect(ok(h.orders.setLineDiscount(h.cashier, order.id, lineId, { kind: 'amount', cents: 700, reason: 'x' })).totals.totalCents).toBe(6300)
  })

  it('a ticket discount, then cleared', () => {
    expect(ok(h.orders.setTicketDiscount(h.cashier, order.id, pct(500))).totals.totalCents).toBe(6650)
    expect(ok(h.orders.setTicketDiscount(h.cashier, order.id, null)).totals.totalCents).toBe(7000)
  })

  it('a discount needs a reason and order.discount', () => {
    expect(code(h.orders.setLineDiscount(h.cashier, order.id, lineId, { kind: 'pct', bp: 500, reason: ' ' }))).toBe('invalid_input')
    const nobody = { ...h.waiter, permissions: new Set<never>() }
    expect(code(h.orders.setLineDiscount(nobody, order.id, lineId, pct(0)))).toBe('forbidden')
  })

  it('free needs order.free_item, or a manager override for it', async () => {
    expect(h.orders.setFree(h.cashier, order.id, lineId, true, 'Geste commercial')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.free_item' } }
    })
    const token = ok(await h.users.authorizeOverride(PINS.amine, 'order.free_item'))
    const dto = ok(h.orders.setFree(h.cashier, order.id, lineId, true, 'Geste commercial', token))
    expect(dto.lines[0]).toMatchObject({ free: true, freeReason: 'Geste commercial', netCents: 0 })
    expect(h.eventRows('order.free').at(-1)).toMatchObject({ data: { lineId, free: true, overriddenBy: h.seeded.users.amine } })
    expect(ok(h.orders.setFree(h.manager, order.id, lineId, false, '')).totals.totalCents).toBe(7000)
  })

  it('below_paid: no change may take the total under what was already paid', () => {
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 5000 }))
    expect(code(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(5000), undefined))).toBe('forbidden')
    expect(code(h.orders.setLineDiscount(h.manager, order.id, lineId, pct(5000)))).toBe('below_paid')
    expect(code(h.orders.setFree(h.manager, order.id, lineId, true, 'x'))).toBe('below_paid')
    expect(code(h.orders.voidLine(h.manager, order.id, lineId, 'x'))).toBe('below_paid')
    expect(code(h.orders.setTicketDiscount(h.manager, order.id, { kind: 'amount', cents: 2001, reason: 'x' }))).toBe('below_paid')
    const two = ok(h.orders.setLineQty(h.cashier, order.id, lineId, 2000))
    expect(two.totals.totalCents).toBe(14000)
    expect(code(h.orders.setLineQty(h.cashier, order.id, lineId, 500))).toBe('invalid_qty')
  })

  it('a below_paid refusal does not spend the override token', async () => {
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 5000 }))
    const token = ok(await h.users.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(code(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(5000), token))).toBe('below_paid')
    expect(ok(h.orders.setLineDiscount(h.cashier, order.id, lineId, pct(2000), token)).totals.totalCents).toBe(5600)
  })

  it('void: free before sending; after sending it needs order.void_sent and a reason, and queues ANNULÉ', () => {
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    expect(h.orders.voidLine(h.cashier, order.id, lineId, 'Client parti')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.void_sent' } }
    })
    expect(code(h.orders.voidLine(h.manager, order.id, lineId, ''))).toBe('invalid_input')
    const dto = ok(h.orders.voidLine(h.manager, order.id, lineId, 'Client parti'))
    expect(dto.lines[0]).toMatchObject({ status: 'void', voidReason: 'Client parti', netCents: 0 })
    expect(h.spooler.jobs().at(-1)).toEqual({
      target: { role: 'kitchen' },
      kind: 'kitchen-cancel',
      payload: { orderId: order.id, lineIds: [lineId] }
    })
    // A sent line's quantity is not edited: void it or add a line.
    const other = ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    expect(code(h.orders.setLineQty(h.cashier, order.id, other.lines[1]!.id, 2000))).toBe('line_sent')
  })

  it('payments: cash capped at what is due, card cannot overpay, zero refused, unknown method refused, removal', () => {
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7001 }))).toBe('overpay_non_cash')
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 0 }))).toBe('invalid_payment')
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 500, tenderedCents: 600 }))).toBe('invalid_payment')
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'bitcoin', amountCents: 500 }))).toBe('unknown_payment_method')
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 500, tenderedCents: 400 }))).toBe(
      'invalid_payment'
    )
    const paid = ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 5000, tenderedCents: 10000 }))
    expect(paid.payments[0]).toMatchObject({ amountCents: 5000, tenderedCents: 10000 })
    expect(paid).toMatchObject({ dueCents: 2000, changeCents: 5000 })
    const full = ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 5000 }))
    expect(full.payments[1]).toMatchObject({ amountCents: 2000, tenderedCents: 5000 })
    expect(code(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 100 }))).toBe('nothing_due')
    const removed = ok(h.orders.removePayment(h.cashier, order.id, full.payments[1]!.id))
    expect(removed).toMatchObject({ paidCents: 5000, dueCents: 2000 })
    expect(code(h.orders.removePayment(h.cashier, order.id, 'nope'))).toBe('invalid_input')
  })
})
