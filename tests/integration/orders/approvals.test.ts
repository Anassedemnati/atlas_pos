import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscountDto } from '../../../src/shared/dto'
import type { Session } from '../../../src/main/domain/users/session'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'
import { PINS } from '../../helpers/users'

/**
 * A discount approval belongs to one order and is its combined discount as it now stands: it never moves
 * to another order (split, move, merge) and goes down when a discount is removed.
 */
describe('orders: discount approvals stay with their order', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const pct = (bp: number): DiscountDto => ({ kind: 'pct', bp, reason: 'Geste commercial' })
  const approvalOf = (orderId: string): number | null =>
    (h.t.db.prepare('SELECT discount_approved_bp AS bp FROM orders WHERE id = ?').get(orderId) as { bp: number | null }).bp
  const overrideToken = () => h.users.authorizeOverride(PINS.amine, 'order.discount.override')
  /** A counter order with one unit of each product. */
  const order = (session: Session, ...productIds: string[]) => {
    const o = ok(h.orders.openOrder(session, { type: 'counter' }))
    for (const productId of productIds) ok(h.orders.addLine(session, o.id, { productId, qtyMilli: 1000, modifierIds: [], note: '' }))
    return ok(h.orders.getOrder(session, o.id))
  }

  describe('split: each part and what is left are checked against the order approval', () => {
    // The 12,00 tea offered at 100 % on a 177,00 bill (tea, couscous, tajine): 6,8 %, within a cashier's 10 %.
    const teaOff = () => {
      const o = order(h.cashier, h.fx.products.the, h.fx.products.couscous, h.fx.products.tajine)
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, { kind: 'pct', bp: 10000, reason: 'x' }))
      return { o, groups: [{ lineIds: [o.lines[1]!.id, o.lines[2]!.id], payments: [{ methodCode: 'card', amountCents: 16500 }] }] }
    }

    it('the probe: a cashier splitting off the paid part leaves a 100 %-off remainder, refused', () => {
      const { o, groups } = teaOff()
      expect(approvalOf(o.id)).toBe(678)
      // What would be left is the tea alone, 100 % off.
      const split = h.tickets.splitAndClose(h.cashier, o.id, groups)
      expect(split).toMatchObject({ ok: false, error: { code: 'discount_over_limit', params: { effectiveBp: 10000, limitBp: 1000 } } })
      expect(h.count('tickets')).toBe(0)
      expect(h.count('payments')).toBe(0)
      expect(ok(h.orders.getOrder(h.cashier, o.id)).lines).toHaveLength(3)
    })

    it('allowed for a manager, or with an override spent once for the whole split', async () => {
      const a = teaOff()
      ok(h.tickets.splitAndClose(h.manager, a.o.id, a.groups))
      expect(approvalOf(a.o.id)).toBe(10000)

      const { o: b, groups } = teaOff()
      const token = ok(await overrideToken())
      // An invalid split is refused before the token is spent.
      expect(code(h.tickets.splitAndClose(h.cashier, b.id, [{ lineIds: ['nope'], payments: [] }], token))).toBe('invalid_split')
      expect(ok(h.tickets.splitAndClose(h.cashier, b.id, groups, token))).toHaveLength(1)
      expect(h.eventRows('order.split').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
    })

    it('a 10 % ticket discount splits at the cashier limit (shares are allowed their rounding centime)', () => {
      const o = order(h.cashier, h.fx.products.the, h.fx.products.tajine, h.fx.products.couscous)
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      const parts = ok(
        h.tickets.splitAndClose(h.cashier, o.id, [
          { lineIds: [o.lines[0]!.id], payments: [{ methodCode: 'card', amountCents: 1080 }] },
          { lineIds: [o.lines[1]!.id], payments: [{ methodCode: 'card', amountCents: 6300 }] }
        ])
      )
      expect(parts.map((t) => t.totalCents)).toEqual([1080, 6300])
      expect(ok(h.orders.getOrder(h.cashier, o.id)).totals.totalCents).toBe(8550)
    })

  })

  it('move: the target does not inherit the source approval (the probe)', async () => {
    const t1 = order(h.cashier, h.fx.products.the, h.fx.products.couscous)
    ok(h.orders.setTicketDiscount(h.manager, t1.id, pct(5000)))
    expect(approvalOf(t1.id)).toBe(5000)
    const t2 = order(h.cashier, h.fx.products.tajine)
    ok(h.orders.moveLines(h.cashier, t1.id, [t1.lines[0]!.id], t2.id))
    expect(approvalOf(t2.id)).toBeNull()
    expect(code(h.orders.setTicketDiscount(h.cashier, t2.id, pct(5000)))).toBe('discount_over_limit')
    expect(ok(h.orders.setTicketDiscount(h.cashier, t2.id, pct(5000), ok(await overrideToken()))).discountApprovedBp).toBe(5000)
  })

  it('move: discounted lines are judged on the target against its own approval', async () => {
    const t1 = order(h.cashier, h.fx.products.the, h.fx.products.couscous)
    ok(h.orders.setLineDiscount(h.manager, t1.id, t1.lines[0]!.id, pct(10000)))
    const t2 = order(h.cashier, h.fx.products.the)
    // 12,00 off 24,00 on the target: 50 %.
    expect(h.orders.moveLines(h.cashier, t1.id, [t1.lines[0]!.id], t2.id)).toMatchObject({
      ok: false,
      error: { code: 'discount_over_limit', params: { effectiveBp: 5000, limitBp: 1000 } }
    })
    ok(h.orders.moveLines(h.manager, t1.id, [t1.lines[0]!.id], t2.id))
    expect(approvalOf(t2.id)).toBe(5000)
    expect(approvalOf(t1.id)).toBeNull()
  })

  it('merge: the merged order keeps its own approval (the probe)', async () => {
    const from = order(h.cashier, h.fx.products.the)
    ok(h.orders.setLineDiscount(h.manager, from.id, from.lines[0]!.id, pct(10000)))
    expect(approvalOf(from.id)).toBe(10000)
    const into = order(h.cashier, h.fx.products.couscous, h.fx.products.tajine, h.fx.products.tajine)
    // 12,00 off 247,00 is 4,9 %: within the cashier's limit; the approval is that, not the 100 % of the tea.
    ok(h.orders.mergeTables(h.cashier, from.id, into.id))
    expect(approvalOf(into.id)).toBe(486)
    expect(code(h.orders.setTicketDiscount(h.cashier, into.id, pct(10000)))).toBe('discount_over_limit')

    const small = order(h.cashier, h.fx.products.the)
    ok(h.orders.setLineDiscount(h.manager, small.id, small.lines[0]!.id, pct(10000)))
    const target = order(h.cashier, h.fx.products.the)
    expect(code(h.orders.mergeTables(h.cashier, small.id, target.id))).toBe('discount_over_limit')
    ok(h.orders.mergeTables(h.cashier, small.id, target.id, ok(await overrideToken())))
    expect(approvalOf(target.id)).toBe(5000)
  })

  it('the approval goes down when a discount is removed: giving it again needs the manager again', () => {
    const o = order(h.cashier, h.fx.products.tajine)
    ok(h.orders.setTicketDiscount(h.manager, o.id, pct(3000)))
    expect(approvalOf(o.id)).toBe(3000)
    ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(500)))
    expect(approvalOf(o.id)).toBe(500)
    expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(3000))).toMatchObject({
      ok: false,
      error: { code: 'discount_over_limit', params: { effectiveBp: 3000, limitBp: 1000 } }
    })
    ok(h.orders.setTicketDiscount(h.cashier, o.id, null))
    expect(approvalOf(o.id)).toBeNull()
  })

  it('a waiter (0 %) voids a line of a table carrying the cashier percentage ticket discount: unchanged, allowed', () => {
    const o = order(h.cashier, h.fx.products.tajine, h.fx.products.the)
    ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
    const dto = ok(h.orders.voidLine(h.waiter, o.id, o.lines[1]!.id, ''))
    expect(dto).toMatchObject({ discountApprovedBp: 1000, totals: { totalCents: 6300 } })
    ok(h.orders.addPayment(h.waiter, o.id, { methodCode: 'card', amountCents: 6300 }))
    ok(h.tickets.closeOrder(h.waiter, o.id))
  })

  it('setFree spends the discount token only once the free-item approval is good', async () => {
    const o = order(h.cashier, h.fx.products.tajine, h.fx.products.the)
    // 8,20 off 82,00: the cashier's 10 %. Offering the tea makes it 8,20 off 70,00, so it needs both approvals.
    ok(h.orders.setTicketDiscount(h.cashier, o.id, { kind: 'amount', cents: 820, reason: 'x' }))
    const discountToken = ok(await overrideToken())
    const wrongFreeToken = ok(await h.users.authorizeOverride(PINS.amine, 'ticket.cancel'))
    expect(code(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', wrongFreeToken, discountToken))).toBe('forbidden')
    const freeToken = ok(await h.users.authorizeOverride(PINS.amine, 'order.free_item'))
    const dto = ok(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', freeToken, discountToken))
    expect(dto).toMatchObject({ discountApprovedBp: 1172, totals: { totalCents: 6180 } })
  })

  describe('split rounding allowance and stored approvals (review probes)', () => {
    /** Extra products: a 500,00 steak, bread at 12,00 / kg (1 g = 1 centime), meat at 120,00 / kg, a free water, 10,05 items. */
    const product = (id: string, price: number, weighed = false): string => {
      h.t.db
        .prepare('INSERT INTO products (id, category_id, name_json, price_cents, vat_bp, sold_by_weight) VALUES (?, ?, ?, ?, 1000, ?)')
        .run(id, h.fx.categories.plats, JSON.stringify({ fr: id }), price, weighed ? 1 : 0)
      return id
    }
    const line = (orderId: string, productId: string, qtyMilli = 1000) =>
      ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli, modifierIds: [], note: '' })).lines.at(-1)!.id
    const splitSteakOff = (orderId: string, steakLine: string) =>
      h.tickets.splitAndClose(h.cashier, orderId, [{ lineIds: [steakLine], payments: [{ methodCode: 'cash', amountCents: 50000 }] }])

    it.each([
      ['A: 100 % off a 1-centime weighed line', 'bread', 1200, 1, 10000, 0],
      ['B: 18,33 % off a 12-centime weighed line', 'meat', 12000, 1, 1833, 0],
      ['B2: 12,08 % off a 48-centime weighed line', 'meat', 12000, 4, 1208, 0],
      ['C: 14,10 % off a 10,00 line beside 40 zero-price lines', 'cheap', 1000, 1000, 1410, 40]
    ] as const)('%s inside a 500,00 order: splitting the steak off is refused', (_name, id, price, qty, bp, zeros) => {
      const steak = product('steak', 50000)
      product(id, price, id !== 'cheap')
      const water = product('water', 0)
      const o = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      const steakLine = line(o.id, steak)
      const tiny = line(o.id, id, qty)
      for (let i = 0; i < zeros; i++) line(o.id, water)
      ok(h.orders.setLineDiscount(h.cashier, o.id, tiny, pct(bp)))
      expect(code(splitSteakOff(o.id, steakLine))).toBe('discount_over_limit')
      expect(h.count('tickets')).toBe(0)
      // Whatever the order holds, the cashier's next discount is judged against 10 %.
      expect(approvalOf(o.id)!).toBeLessThanOrEqual(1000)
    })

    it('the allowance covers a ticket discount share, and the stored approval never exceeds the session limit', () => {
      const item = product('item', 1005)
      const o = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      const lines = [line(o.id, item), line(o.id, item), line(o.id, item)]
      // 10 % of 30,15 = 3,02, shared 1,01 / 1,01 / 1,00.
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      const [part] = ok(
        h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [lines[2]!], payments: [{ methodCode: 'card', amountCents: 905 }] }])
      )
      expect(part!.totalCents).toBe(905)
      // What is left (2,02 off 20,10, 10,05 %) passes on its two centimes but is stored as 10 %.
      expect(ok(h.orders.getOrder(h.cashier, o.id)).totals.totalCents).toBe(1808)
      expect(approvalOf(o.id)).toBe(1000)
    })

    it('a manager-approved amount does not widen as the bill grows: the cashier cannot then set a larger percentage', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.manager, o.id, { kind: 'amount', cents: 3500, reason: 'x' }))
      expect(approvalOf(o.id)).toBe(5000)
      ok(h.orders.addLine(h.cashier, o.id, { productId: h.fx.products.couscous, qtyMilli: 1000, modifierIds: [], note: '' }))
      // 35,00 off 165,00.
      expect(approvalOf(o.id)).toBe(2122)
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000))).toMatchObject({
        ok: false,
        error: { code: 'discount_over_limit', params: { effectiveBp: 5000, limitBp: 2122 } }
      })
    })

    it('a percentage keeps its approval when the bill grows', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.manager, o.id, pct(3000)))
      ok(h.orders.addLine(h.cashier, o.id, { productId: h.fx.products.couscous, qtyMilli: 1000, modifierIds: [], note: '' }))
      expect(approvalOf(o.id)).toBe(3000)
    })

    it('setFree checks the discount token before it spends the free-item token', async () => {
      const o = order(h.cashier, h.fx.products.tajine, h.fx.products.the)
      ok(h.orders.setTicketDiscount(h.cashier, o.id, { kind: 'amount', cents: 820, reason: 'x' }))
      const freeToken = ok(await h.users.authorizeOverride(PINS.amine, 'order.free_item'))
      const wrongDiscountToken = ok(await h.users.authorizeOverride(PINS.amine, 'ticket.cancel'))
      const r = h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', freeToken, wrongDiscountToken)
      expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'override_invalid' } } })
      // The free-item approval is still good.
      ok(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', freeToken, ok(await overrideToken())))
    })
  })
})
