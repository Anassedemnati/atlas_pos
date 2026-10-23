import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscountDto } from '../../../src/shared/dto'
import type { OverrideToken, Session } from '../../../src/main/domain/users/session'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'
import { PINS } from '../../helpers/users'

/**
 * The discount limit (Task 12 ruling, fix round 4): the money an order's discounts take off must stay
 * within the acting user's own percentage of the gross, or what a manager approved on that order (a
 * ticket percentage that follows the bill, plus a budget in centimes that does not), each with a rounding
 * centime per discounted line. Approvals belong to their order: a split hands each part at most its own
 * discount of the budget, a move carries the moved lines' line discounts, a merge adds the budgets.
 */
describe('orders: the discount limit, own percentage plus manager approvals', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const pct = (bp: number): DiscountDto => ({ kind: 'pct', bp, reason: 'Geste commercial' })
  const amount = (cents: number): DiscountDto => ({ kind: 'amount', cents, reason: 'Geste commercial' })
  const approvalsOf = (orderId: string): { bp: number; cents: number } =>
    h.t.db.prepare('SELECT approved_ticket_bp AS bp, approved_cents AS cents FROM orders WHERE id = ?').get(orderId) as {
      bp: number
      cents: number
    }
  const overrideToken = () => h.users.authorizeOverride(PINS.amine, 'order.discount.override')
  const addLine = (session: Session, orderId: string, productId: string, qtyMilli = 1000, token?: OverrideToken) =>
    h.orders.addLine(session, orderId, { productId, qtyMilli, modifierIds: [], note: '' }, token)
  /** A counter order with one unit of each product, opened and filled by `session`. */
  const order = (session: Session, ...productIds: string[]) => {
    const o = ok(h.orders.openOrder(session, { type: 'counter' }))
    for (const productId of productIds) ok(addLine(session, o.id, productId))
    return ok(h.orders.getOrder(session, o.id))
  }
  const lineIds = (orderId: string): string[] =>
    ok(h.orders.getOrder(h.manager, orderId))
      .lines.filter((l) => l.status === 'active')
      .map((l) => l.id)
  const payAll = (session: Session, orderId: string) => {
    const due = ok(h.orders.getOrder(session, orderId)).dueCents
    if (due > 0) ok(h.orders.addPayment(session, orderId, { methodCode: 'cash', amountCents: due }))
  }
  const over = (discountCents: number, limitCents: number) => ({
    ok: false,
    error: { code: 'discount_over_limit', params: { discountCents, limitCents } }
  })
  /** Extra products (the reviewer's): a 500,00 steak, 10,00 and 90,00 items, bread and meat by weight, 10,05 items, 10,00 / kg nuts, free water. */
  const product = (id: string, price: number, weighed = false): string => {
    h.t.db
      .prepare('INSERT INTO products (id, category_id, name_json, price_cents, vat_bp, sold_by_weight) VALUES (?, ?, ?, ?, 1000, ?)')
      .run(id, h.fx.categories.plats, JSON.stringify({ fr: id }), price, weighed ? 1 : 0)
    return id
  }

  describe('the check', () => {
    it('discount-probe: an amount larger than what it applies to is invalid, on an empty order for anyone', () => {
      const empty = ok(h.orders.openOrder(h.waiter, { type: 'counter' }))
      for (const session of [h.waiter, h.cashier, h.manager]) {
        expect(h.orders.setTicketDiscount(session, empty.id, amount(5000))).toMatchObject({
          ok: false,
          error: { code: 'invalid_discount', params: { kind: 'amount', value: 5000, baseCents: 0 } }
        })
      }
      expect(ok(h.orders.getOrder(h.cashier, empty.id)).discount).toBeNull()
      // On a line too: 12,01 off a 12,00 tea.
      const o = order(h.cashier, h.fx.products.the)
      expect(code(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, amount(1201)))).toBe('invalid_discount')
      expect(ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, amount(1200))).totals.totalCents).toBe(0)
    })

    it('the limit is the own percentage of the gross plus a rounding centime per discounted line: 7,01 off 70,00 passes, 7,02 is over', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      expect(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, amount(702))).toMatchObject(over(702, 701))
      expect(ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, amount(701))).totals.totalCents).toBe(6299)
      // Within the own limit, nothing is approved: the order carries no manager approval.
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
    })

    it('P4: 40 lines of 5 centimes at 10 % each round to a centime apiece (20 %): allowed, the tolerance is one centime per discounted line', () => {
      const nut = product('nut', 1000, true)
      const o = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      for (let i = 0; i < 40; i++) ok(addLine(h.cashier, o.id, nut, 5))
      for (const lineId of lineIds(o.id)) ok(h.orders.setLineDiscount(h.cashier, o.id, lineId, pct(1000)))
      expect(ok(h.orders.getOrder(h.cashier, o.id)).totals).toMatchObject({ grossCents: 200, lineDiscountsCents: 40, totalCents: 160 })
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(160)
    })

    it('a session holding order.discount.override is unlimited; a token is spent last and logged', async () => {
      const o = order(h.cashier, h.fx.products.tajine)
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000))).toMatchObject(over(3500, 701))
      const token = ok(await overrideToken())
      // Refused before the token is spent: the line does not exist.
      expect(code(h.orders.setLineDiscount(h.cashier, o.id, 'nope', pct(5000), token))).toBe('invalid_input')
      expect(ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000), token))).toMatchObject({ approvedTicketBp: 5000, approvedCents: 0 })
      expect(h.eventRows('order.discount').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
      // One use only: offered again, the spent token is refused as invalid.
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(6000), token)).toMatchObject({
        ok: false,
        error: { code: 'forbidden', params: { reason: 'override_invalid' } }
      })
      expect(ok(h.orders.setTicketDiscount(h.manager, o.id, pct(6000)))).toMatchObject({ approvedTicketBp: 6000 })
    })
  })

  describe('approvals after a discount change', () => {
    it('a manager ticket percentage follows the bill: the waiter adds a dessert and closes', () => {
      const o = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4 }))
      ok(addLine(h.cashier, o.id, h.fx.products.tajine))
      ok(addLine(h.cashier, o.id, h.fx.products.couscous))
      expect(ok(h.orders.setTicketDiscount(h.manager, o.id, pct(5000)))).toMatchObject({ approvedTicketBp: 5000, totals: { totalCents: 8250 } })
      expect(ok(addLine(h.waiter, o.id, h.fx.products.the)).totals.totalCents).toBe(8850)
      payAll(h.waiter, o.id)
      expect(ok(h.tickets.closeOrder(h.waiter, o.id)).totalCents).toBe(8850)
    })

    it('the cashier own ticket percentage is approved up to the own limit: the waiter voids a line and closes', () => {
      const o = order(h.cashier, h.fx.products.tajine, h.fx.products.the)
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 1000, cents: 0 })
      expect(ok(h.orders.voidLine(h.waiter, o.id, o.lines[1]!.id, ''))).toMatchObject({ approvedTicketBp: 1000, totals: { totalCents: 6300 } })
      payAll(h.waiter, o.id)
      ok(h.tickets.closeOrder(h.waiter, o.id))
    })

    it('a line discount within the own limit approves nothing: the waiter (0 %) cannot add to or close that order', async () => {
      const o = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, pct(1000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      expect(addLine(h.waiter, o.id, h.fx.products.the)).toMatchObject(over(700, 1))
      payAll(h.cashier, o.id)
      expect(h.tickets.closeOrder(h.waiter, o.id)).toMatchObject(over(700, 1))
      // The cashier, or a manager token, can.
      // Growing the bill records nothing, even on a token.
      expect(ok(addLine(h.waiter, o.id, h.fx.products.the, 1000, ok(await overrideToken())))).toMatchObject({
        approvedCents: 0,
        totals: { totalCents: 7500 }
      })
      expect(h.eventRows('order.line_added').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(7500)
    })

    it('a manager pass covers the whole state: a ticket percentage over line discounts leaves a budget for the uncovered part', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, pct(1000)))
      // 7,00 line discount plus 50 % of the 63,00 net (31,50): 38,50 off 70,00, of which 35,00 is the percentage.
      expect(ok(h.orders.setTicketDiscount(h.manager, o.id, pct(5000)))).toMatchObject({
        approvedTicketBp: 5000,
        approvedCents: 350,
        totals: { totalCents: 3150 }
      })
      payAll(h.waiter, o.id)
      expect(ok(h.tickets.closeOrder(h.waiter, o.id)).totalCents).toBe(3150)
    })

    it('a manager amount becomes a budget that does not grow with the bill (P3b): the cashier cannot widen it', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      expect(ok(h.orders.setTicketDiscount(h.manager, o.id, amount(3500)))).toMatchObject({ approvedTicketBp: 0, approvedCents: 3500 })
      ok(addLine(h.cashier, o.id, h.fx.products.couscous))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 3500 })
      // 50 % of 165,00 is 82,50; a percentage in place of the amount would drop the budget, leaving the cashier's 16,50.
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000))).toMatchObject(over(8250, 1652))
      // The amount itself may be moved around within the budget.
      expect(ok(h.orders.setTicketDiscount(h.cashier, o.id, amount(3500))).totals.totalCents).toBe(13000)
    })

    it('the approval goes down with the discount: a manager 30 % lowered to 5 % cannot be raised again; removal clears it', () => {
      const o = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.manager, o.id, pct(3000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 3000, cents: 0 })
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(500)))
      expect(approvalsOf(o.id)).toEqual({ bp: 500, cents: 0 })
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(3000))).toMatchObject(over(2100, 701))
      ok(h.orders.setTicketDiscount(h.cashier, o.id, null))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      // A budget is cleared once nothing it covers is left.
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, amount(2000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 2000 })
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, null))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
    })

    it('a base change approved by token records the state the manager saw: the cashier then closes without a new token', async () => {
      const o = order(h.cashier, h.fx.products.tajine, h.fx.products.tajine, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.cashier, o.id, amount(2100)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      // 21,00 off 140,00 (15 %) needs the manager; the 21,00 is then the order's budget.
      expect(h.orders.voidLine(h.cashier, o.id, o.lines[2]!.id, '')).toMatchObject(over(2100, 1402))
      const dto = ok(h.orders.voidLine(h.cashier, o.id, o.lines[2]!.id, '', ok(await overrideToken())))
      expect(dto).toMatchObject({ approvedTicketBp: 0, approvedCents: 2100, totals: { totalCents: 11900 } })
      expect(h.eventRows('order.line_void').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
      // Raising the discount is refused again; the budget is absolute, so a further shrink stays within it.
      expect(h.orders.setTicketDiscount(h.cashier, o.id, amount(2200))).toMatchObject(over(2200, 2102))
      expect(ok(h.orders.voidLine(h.cashier, o.id, o.lines[1]!.id, ''))).toMatchObject({ approvedCents: 2100, totals: { totalCents: 4900 } })
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(4900)

      // A manager's own void is not an approval of a budget: nothing is recorded, the close needs a token.
      const m = order(h.cashier, h.fx.products.tajine, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.cashier, m.id, amount(1400)))
      expect(ok(h.orders.voidLine(h.manager, m.id, m.lines[1]!.id, ''))).toMatchObject({ approvedCents: 0 })
      payAll(h.cashier, m.id)
      expect(h.tickets.closeOrder(h.cashier, m.id)).toMatchObject(over(1400, 701))
      expect(ok(h.tickets.closeOrder(h.cashier, m.id, ok(await overrideToken()))).totalCents).toBe(5600)
    })
  })

  describe('growing the bill (P2, P3, P5)', () => {
    let cheap: string
    let big: string
    beforeEach(() => {
      cheap = product('cheap', 1000)
      big = product('big', 9000)
    })

    it('P2: a manager 100 % on a 90,00 line is a 90,00 budget; after 10 more 90,00 lines the cashier 80 % ticket is refused', () => {
      const o = order(h.cashier, cheap, big)
      expect(ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[1]!.id, pct(10000)))).toMatchObject({ approvedCents: 9000 })
      for (let i = 0; i < 10; i++) ok(addLine(h.cashier, o.id, big))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 9000 })
      // 80 % of the 910,00 net plus the 90,00 line: 818,00 off 1 000,00; allowed: 10 % own plus the budget.
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(8000))).toMatchObject(over(81800, 19012))
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).snapshot.totals).toMatchObject({ grossCents: 100000, lineDiscountsCents: 9000, totalCents: 91000 })
    })

    it('P5: converting the manager amount into a line percentage keeps the budget; growth does not widen it', () => {
      const o = order(h.cashier, cheap, big)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[1]!.id, amount(9000)))
      expect(ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[1]!.id, pct(10000)))).toMatchObject({ approvedCents: 9000 })
      for (let i = 0; i < 10; i++) ok(addLine(h.cashier, o.id, big))
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(8000))).toMatchObject(over(81800, 19012))
      // The quantity going up is a base change too: checked, nothing raised.
      expect(ok(h.orders.setLineQty(h.cashier, o.id, o.lines[0]!.id, 90000))).toMatchObject({ approvedCents: 9000 })
    })

    it('P3: a manager 50,00 amount cannot be converted by the cashier into a 50 % percentage that would follow the bill', () => {
      const o = order(h.cashier, cheap, big)
      ok(h.orders.setTicketDiscount(h.manager, o.id, amount(5000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 5000 })
      // The percentage would leave the order with a 10 % approval only: not a state the cashier may hold.
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000))).toMatchObject(over(5000, 1002))
      expect(ok(h.orders.getOrder(h.cashier, o.id)).discount).toEqual(amount(5000))
      for (let i = 0; i < 10; i++) ok(addLine(h.cashier, o.id, big))
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(5000))).toMatchObject(over(50000, 10012))
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).snapshot.totals).toMatchObject({ grossCents: 100000, ticketDiscountCents: 5000, totalCents: 95000 })
    })
  })

  describe('split: each part and what is left are checked, the budget is shared out', () => {
    it('split-probe: the cashier splitting the paid part off leaves a 100 %-off cheap line: refused, nothing written', () => {
      const o = order(h.cashier, product('cheap', 1000), product('big', 9000))
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, pct(10000)))
      const split = h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[1]!.id], payments: [{ methodCode: 'cash', amountCents: 9000 }] }])
      expect(split).toMatchObject(over(1000, 101))
      expect(h.count('tickets')).toBe(0)
      expect(h.count('payments')).toBe(0)
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
    })

    it('P1: the cashier 10 % on 3 x 10,05, one line split off, the remainder paid and closed by the cashier', () => {
      const item = product('item', 1005)
      const o = order(h.cashier, item, item, item)
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      const [part] = ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[2]!.id], payments: [{ methodCode: 'card', amountCents: 905 }] }]))
      expect(part!.totalCents).toBe(905)
      const rest = ok(h.orders.getOrder(h.cashier, o.id))
      expect(rest).toMatchObject({ discount: { kind: 'amount', cents: 202 }, approvedTicketBp: 1000, approvedCents: 0, totals: { totalCents: 1808 } })
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(1808)
    })

    const steakAndTiny = (tinyId: string, tinyPrice: number, qty: number, weighed: boolean, zeros: number) => {
      product('steak', 50000)
      product(tinyId, tinyPrice, weighed)
      product('water', 0)
      const o = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      const steak = ok(addLine(h.cashier, o.id, 'steak')).lines[0]!.id
      const tiny = ok(addLine(h.cashier, o.id, tinyId, qty)).lines[1]!.id
      for (let i = 0; i < zeros; i++) ok(addLine(h.cashier, o.id, 'water'))
      return { o, steak, tiny }
    }
    const splitSteakOff = (orderId: string, steak: string) =>
      h.tickets.splitAndClose(h.cashier, orderId, [{ lineIds: [steak], payments: [{ methodCode: 'cash', amountCents: 50000 }] }])

    it.each([
      ['A: 100 % off a 1-centime weighed line', 'bread', 1200, 1, 10000, 0, true, 1],
      ['B: 18,33 % off a 12-centime weighed line', 'meat', 12000, 1, 1833, 0, true, 2],
      ['B2: 12,08 % off a 48-centime weighed line', 'meat', 12000, 4, 1208, 0, true, 6],
      ['C: 14,10 % off a 10,00 line beside 40 zero-price lines', 'cheap', 1000, 1000, 1410, 40, false, 141]
    ] as const)('%s inside a 500,00 order, the steak split off: the remainder stays within the own limit plus a centime', (_n, id, price, qty, bp, zeros, allowed, off) => {
      const { o, steak, tiny } = steakAndTiny(id, price, qty, id !== 'cheap', zeros)
      ok(h.orders.setLineDiscount(h.cashier, o.id, tiny, pct(bp)))
      const split = splitSteakOff(o.id, steak)
      const rest = ok(h.orders.getOrder(h.cashier, o.id))
      if (allowed) {
        ok(split)
        // The remainder's discount is within 10 % of its gross plus the one discounted line's centime.
        expect(rest.totals.lineDiscountsCents).toBe(off)
        expect(off).toBeLessThanOrEqual(Math.round(rest.totals.grossCents / 10) + 1)
      } else {
        expect(split).toMatchObject(over(off, 101))
        expect(h.count('tickets')).toBe(0)
      }
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      // Whatever is left, the cashier's next discount is judged against 10 % of it.
      ok(addLine(h.cashier, o.id, 'steak'))
      expect(code(h.orders.setTicketDiscount(h.cashier, o.id, pct(10000)))).toBe('discount_over_limit')
    })

    it('a manager budget is shared out: each piece takes what it needs, in order, and the rest is dropped; allowed with an override spent once', async () => {
      const o = order(h.cashier, h.fx.products.the, h.fx.products.couscous, h.fx.products.tajine)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, pct(10000)))
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[2]!.id, amount(2000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 3200 })
      const [tea] = ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[0]!.id], payments: [] }]))
      expect(tea!.totalCents).toBe(0)
      // The tea part needs 12,00 less its rounding centime; what is left (20,00 off 165,00, over 10 %)
      // needs 20,00 less its centime out of what is left of the budget: 31,98 of the 32,00, never more.
      expect(approvalsOf(tea!.orderId)).toEqual({ bp: 0, cents: 1199 })
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 1999 })

      // Without a budget, a part over the cashier's limit refuses the whole split until a manager approves.
      const b = order(h.cashier, h.fx.products.the, h.fx.products.couscous)
      ok(h.orders.setLineDiscount(h.cashier, b.id, b.lines[0]!.id, pct(5000)))
      const groups = [{ lineIds: [b.lines[0]!.id], payments: [{ methodCode: 'card', amountCents: 600 }] }]
      expect(h.tickets.splitAndClose(h.cashier, b.id, groups)).toMatchObject(over(600, 121))
      const token = ok(await overrideToken())
      expect(code(h.tickets.splitAndClose(h.cashier, b.id, [{ lineIds: ['nope'], payments: [] }], token))).toBe('invalid_split')
      expect(ok(h.tickets.splitAndClose(h.cashier, b.id, groups, token))).toHaveLength(1)
      expect(h.eventRows('order.split').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
    })
  })

  describe('move and merge: approvals stay with their order', () => {
    it('move2: the target does not inherit the source ticket percentage', async () => {
      const t1 = order(h.cashier, h.fx.products.the, h.fx.products.couscous)
      ok(h.orders.setTicketDiscount(h.manager, t1.id, pct(5000)))
      const t2 = order(h.cashier, h.fx.products.tajine)
      ok(h.orders.moveLines(h.cashier, t1.id, [t1.lines[0]!.id], t2.id))
      expect(approvalsOf(t2.id)).toEqual({ bp: 0, cents: 0 })
      expect(h.orders.setTicketDiscount(h.cashier, t2.id, pct(5000))).toMatchObject(over(4100, 822))
      expect(ok(h.orders.setTicketDiscount(h.cashier, t2.id, pct(5000), ok(await overrideToken())))).toMatchObject({ approvedTicketBp: 5000 })
    })

    it('move: a line discount travels with its budget, at most what the source holds', async () => {
      const t1 = order(h.cashier, h.fx.products.the, h.fx.products.couscous)
      ok(h.orders.setLineDiscount(h.manager, t1.id, t1.lines[0]!.id, pct(10000)))
      const t2 = order(h.cashier, h.fx.products.the)
      // 12,00 off 24,00 on the target: covered by the 12,00 that comes with the line.
      ok(h.orders.moveLines(h.cashier, t1.id, [t1.lines[0]!.id], t2.id))
      expect(approvalsOf(t2.id)).toEqual({ bp: 0, cents: 1200 })
      expect(approvalsOf(t1.id)).toEqual({ bp: 0, cents: 0 })
      expect(h.eventRows('order.lines_moved_in').at(-1)).toMatchObject({ data: { carriedCents: 1200 } })

      // The cashier's own line discount carries nothing: judged anew on the target.
      const a = order(h.cashier, product('cheap', 1000), product('big', 9000))
      ok(h.orders.setLineDiscount(h.cashier, a.id, a.lines[0]!.id, pct(10000)))
      const b = order(h.cashier, h.fx.products.the)
      expect(h.orders.moveLines(h.cashier, a.id, [a.lines[0]!.id], b.id)).toMatchObject(over(1000, 221))
      ok(h.orders.moveLines(h.cashier, a.id, [a.lines[0]!.id], b.id, ok(await overrideToken())))
      // The target grew: nothing is recorded on it (closing it will need the manager), nothing on the source.
      expect(approvalsOf(b.id)).toEqual({ bp: 0, cents: 0 })
      expect(approvalsOf(a.id)).toEqual({ bp: 0, cents: 0 })
    })

    it('merge-probe: the merged order keeps its ticket percentage and adds the two budgets', async () => {
      const from = order(h.cashier, h.fx.products.the)
      ok(h.orders.setLineDiscount(h.manager, from.id, from.lines[0]!.id, pct(10000)))
      const into = order(h.cashier, h.fx.products.couscous, h.fx.products.tajine, h.fx.products.tajine)
      ok(h.orders.setTicketDiscount(h.cashier, into.id, pct(500)))
      ok(h.orders.mergeTables(h.cashier, from.id, into.id))
      expect(approvalsOf(into.id)).toEqual({ bp: 500, cents: 1200 })
      expect(code(h.orders.setTicketDiscount(h.cashier, into.id, pct(10000)))).toBe('discount_over_limit')

      // A source with a ticket discount is refused; the cashier's own line discount brings no budget, so
      // under the target's own 10 % ticket discount the merged order is over: 14,00 + 16,30 off 177,00.
      const small = order(h.cashier, h.fx.products.tajine, h.fx.products.couscous)
      ok(h.orders.setTicketDiscount(h.cashier, small.id, pct(1000)))
      expect(code(h.orders.mergeTables(h.cashier, small.id, into.id))).toBe('ticket_discount_set')
      ok(h.orders.setTicketDiscount(h.cashier, small.id, null))
      ok(h.orders.setLineDiscount(h.cashier, small.id, small.lines[0]!.id, pct(2000)))
      const target = order(h.cashier, h.fx.products.the)
      ok(h.orders.setTicketDiscount(h.cashier, target.id, pct(1000)))
      expect(h.orders.mergeTables(h.cashier, small.id, target.id)).toMatchObject(over(3030, 1773))
      ok(h.orders.mergeTables(h.cashier, small.id, target.id, ok(await overrideToken())))
      expect(h.eventRows('order.merged').at(-1)).toMatchObject({ data: { overriddenBy: h.seeded.users.amine } })
      // A merge grows the target: the token's pass records nothing.
      expect(approvalsOf(target.id)).toEqual({ bp: 1000, cents: 0 })
    })
  })

  describe('the budget is a partition; incidental manager actions mint nothing (round 5 probes)', () => {
    let cheap: string
    let big: string
    let steak: string
    beforeEach(() => {
      cheap = product('cheap', 1000)
      big = product('big', 9000)
      steak = product('steak', 50000)
    })
    /** What the tickets took off beyond 10 % of their gross, in centimes. */
    const beyondOwnLimit = (): number =>
      (h.t.db.prepare('SELECT snapshot_json AS s FROM tickets').all() as { s: string }[])
        .map((row) => (JSON.parse(row.s) as { totals: { grossCents: number; totalCents: number } }).totals)
        .reduce((sum, t) => sum + (t.grossCents - t.totalCents) - Math.round(t.grossCents / 10), 0)

    it('S1: the part that carries the manager line discount takes the budget; what is left gets none', () => {
      const o = order(h.cashier, big, steak, steak)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, pct(10000)))
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 1000, cents: 9000 })
      const [part] = ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[0]!.id], payments: [] }]))
      // 90,00 off: the 10 % ticket approval covers 9,00 and a centime, the budget the 80,99 beyond.
      expect(approvalsOf(part!.orderId)).toEqual({ bp: 1000, cents: 8099 })
      expect(ok(h.orders.getOrder(h.cashier, o.id))).toMatchObject({ discount: amount(10000), approvedTicketBp: 1000, approvedCents: 0 })
      expect(h.orders.setLineDiscount(h.cashier, o.id, o.lines[1]!.id, amount(9000))).toMatchObject(over(19000, 10002))
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(90000)
      expect(beyondOwnLimit()).toBeLessThanOrEqual(9000)
    })

    it('S3: a manager approval cannot be extracted again on every split round', () => {
      const o = order(h.cashier, big, steak)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, pct(10000)))
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[1]!.id, amount(1)))
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[0]!.id], payments: [] }]))
      expect(approvalsOf(o.id)).toEqual({ bp: 1000, cents: 0 })
      for (let round = 0; round < 3; round++) {
        ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
        const added = ok(addLine(h.cashier, o.id, steak)).lines.at(-1)!.id
        expect(code(h.orders.setLineDiscount(h.cashier, o.id, added, amount(9000)))).toBe('discount_over_limit')
        const [part] = ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [added], payments: [{ methodCode: 'cash', amountCents: 45000 }] }]))
        expect(part!.totalCents).toBe(45000)
        expect(approvalsOf(o.id)).toEqual({ bp: 1000, cents: 0 })
      }
      payAll(h.cashier, o.id)
      ok(h.tickets.closeOrder(h.cashier, o.id))
      expect(beyondOwnLimit()).toBeLessThanOrEqual(9000)
    })

    it('S4: without a ticket percentage, the cashier own line discount in what is left becomes no budget', () => {
      const o = order(h.cashier, big, steak, steak, steak, steak)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, pct(10000)))
      // 90,00 on the first steak: within 10 % of 2 090,00.
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[1]!.id, amount(9000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 9000 })
      const [part] = ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[0]!.id], payments: [] }]))
      expect(approvalsOf(part!.orderId)).toEqual({ bp: 0, cents: 8999 })
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      ok(h.orders.voidLine(h.cashier, o.id, o.lines[2]!.id, ''))
      ok(h.orders.voidLine(h.cashier, o.id, o.lines[3]!.id, ''))
      expect(h.orders.voidLine(h.cashier, o.id, o.lines[4]!.id, '')).toMatchObject(over(9000, 5001))
      payAll(h.cashier, o.id)
      expect(ok(h.tickets.closeOrder(h.cashier, o.id)).totalCents).toBe(91000)
    })

    it('M2: what a split leaves carries no budget into a merge', () => {
      const o = order(h.cashier, big, steak, steak)
      const t = order(h.cashier, steak, steak)
      ok(h.orders.setLineDiscount(h.manager, o.id, o.lines[0]!.id, pct(10000)))
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      ok(h.tickets.splitAndClose(h.cashier, o.id, [{ lineIds: [o.lines[0]!.id], payments: [] }]))
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[1]!.id, amount(1)))
      ok(h.orders.setTicketDiscount(h.cashier, o.id, null))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      ok(h.orders.mergeTables(h.cashier, o.id, t.id))
      expect(approvalsOf(t.id)).toEqual({ bp: 0, cents: 0 })
      ok(h.orders.setTicketDiscount(h.cashier, t.id, pct(1000)))
      expect(code(h.orders.setLineDiscount(h.cashier, t.id, t.lines[1]!.id, amount(9000)))).toBe('discount_over_limit')
    })

    it('S5: a manager adding a line, or voiding one, on an order holding only the cashier own discount mints no budget', () => {
      const o = order(h.cashier, steak, steak, steak, steak, steak, steak, steak, steak, steak, steak)
      ok(h.orders.setLineDiscount(h.cashier, o.id, o.lines[0]!.id, amount(50000)))
      expect(ok(addLine(h.manager, o.id, cheap))).toMatchObject({ approvedCents: 0 })
      expect(h.orders.voidLine(h.cashier, o.id, o.lines[1]!.id, '')).toMatchObject(over(50000, 45101))
      expect(ok(h.orders.voidLine(h.manager, o.id, o.lines[1]!.id, ''))).toMatchObject({ approvedCents: 0 })
      expect(h.orders.voidLine(h.cashier, o.id, o.lines[2]!.id, '')).toMatchObject(over(50000, 40101))
    })

    it('control A: alternating ticket kinds and a manager free item leave no budget behind', () => {
      const o = order(h.cashier, steak, big, cheap)
      ok(h.orders.setTicketDiscount(h.manager, o.id, amount(5000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 5000 })
      ok(h.orders.setTicketDiscount(h.cashier, o.id, pct(1000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 1000, cents: 0 })
      ok(h.orders.setTicketDiscount(h.cashier, o.id, amount(5000)))
      expect(approvalsOf(o.id)).toEqual({ bp: 0, cents: 0 })
      expect(ok(h.orders.setFree(h.manager, o.id, o.lines[1]!.id, true, 'Geste'))).toMatchObject({ approvedCents: 0 })
      expect(h.orders.setTicketDiscount(h.cashier, o.id, pct(2000))).toMatchObject(over(10200, 5102))
      expect(h.orders.voidLine(h.cashier, o.id, o.lines[0]!.id, '')).toMatchObject(over(1000, 101))
    })
  })

  describe('setFree and the tokens', () => {
    it('setFree is a base change, checked with the discount token validated before the free-item token is spent', async () => {
      const o = order(h.cashier, h.fx.products.tajine, h.fx.products.the)
      // 8,20 off 82,00: the cashier's 10 %. Offering the tea makes it 8,20 off 70,00, so it needs both approvals.
      ok(h.orders.setTicketDiscount(h.cashier, o.id, amount(820)))
      const freeToken = ok(await h.users.authorizeOverride(PINS.amine, 'order.free_item'))
      const wrongDiscountToken = ok(await h.users.authorizeOverride(PINS.amine, 'ticket.cancel'))
      expect(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', freeToken, wrongDiscountToken)).toMatchObject({
        ok: false,
        error: { code: 'forbidden', params: { reason: 'override_invalid' } }
      })
      const discountToken = ok(await overrideToken())
      const wrongFreeToken = ok(await h.users.authorizeOverride(PINS.amine, 'ticket.cancel'))
      expect(code(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', wrongFreeToken, discountToken))).toBe('forbidden')
      // Both tokens are still good; the 8,20 the manager approved on 70,00 is recorded.
      const dto = ok(h.orders.setFree(h.cashier, o.id, o.lines[1]!.id, true, 'Geste', freeToken, discountToken))
      expect(dto).toMatchObject({ approvedTicketBp: 0, approvedCents: 820, totals: { totalCents: 6180 } })
      expect(h.eventRows('order.free').at(-1)).toMatchObject({
        data: { overriddenBy: h.seeded.users.amine, discountOverriddenBy: h.seeded.users.amine }
      })
    })
  })
})
