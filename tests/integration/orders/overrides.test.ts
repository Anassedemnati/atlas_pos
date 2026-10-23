import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCatalogService } from '../../../src/main/application/usecases/catalog'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'
import { PINS } from '../../helpers/users'

// A manager's approval (`users.authorizeOverride`) stands in for a permission the signed-in user lacks.
describe('manager approvals for what a cashier may not do alone', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  const token = async (permission: Parameters<SalesHarness['users']['authorizeOverride']>[1]) => ok(await h.users.authorizeOverride(PINS.amine, permission))

  describe('voiding a line already sent to the kitchen (order.void_sent)', () => {
    const sentLine = (tableId = h.fx.tables.t4) => {
      const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId, covers: 2 }))
      ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.tajine, qtyMilli: 1000, modifierIds: [], note: '' }))
      const sent = ok(h.orders.sendToKitchen(h.cashier, order.id))
      return { orderId: order.id, lineId: sent.lines[0]!.id }
    }

    it('a cashier is refused without approval, and with a wrong-permission or a missing reason nothing is spent', async () => {
      const { orderId, lineId } = sentLine()
      expect(h.orders.voidLine(h.cashier, orderId, lineId, 'Erreur')).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'order.void_sent' } } })
      const wrong = await token('order.free_item')
      expect(h.orders.voidLine(h.cashier, orderId, lineId, 'Erreur', undefined, wrong)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'override_invalid' } } })
      const good = await token('order.void_sent')
      expect(code(h.orders.voidLine(h.cashier, orderId, lineId, '', undefined, good))).toBe('invalid_input')
      // The refusals above did not spend the approval.
      const dto = ok(h.orders.voidLine(h.cashier, orderId, lineId, 'Erreur de saisie', undefined, good))
      expect(dto.lines[0]).toMatchObject({ status: 'void', voidReason: 'Erreur de saisie' })
    })

    it('the approval voids the line, queues the kitchen cancellation, logs who approved, and works once', async () => {
      const { orderId, lineId } = sentLine()
      const before = h.spooler.jobs().filter((j) => j.kind === 'kitchen-cancel').length
      const approval = await token('order.void_sent')
      const dto = ok(h.orders.voidLine(h.cashier, orderId, lineId, 'Erreur de saisie', undefined, approval))
      expect(dto.totals.totalCents).toBe(0)
      expect(h.spooler.jobs().filter((j) => j.kind === 'kitchen-cancel')).toHaveLength(before + 1)
      expect(h.eventRows('order.line_void').at(-1)).toMatchObject({
        user_id: h.cashier.userId,
        data: { lineId, sent: true, voidOverriddenBy: h.seeded.users.amine }
      })
      const other = sentLine(h.fx.tables.t5)
      expect(code(h.orders.voidLine(h.cashier, other.orderId, other.lineId, 'Erreur', undefined, approval))).toBe('forbidden')
    })

    it('a line not yet sent needs no approval, and a manager needs none either', () => {
      const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t5 }))
      const line = ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' })).lines[0]!
      ok(h.orders.voidLine(h.cashier, order.id, line.id, ''))
      const { orderId, lineId } = sentLine(h.fx.tables.t4)
      ok(h.orders.voidLine(h.manager, orderId, lineId, 'Erreur'))
      expect(h.eventRows('order.line_void').at(-1)!.data).not.toHaveProperty('voidOverriddenBy')
    })
  })

  describe('the Z closure (day.close)', () => {
    const sale = () => {
      const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
      ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
      ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
      ok(h.tickets.closeOrder(h.cashier, order.id))
    }

    it('a cashier closes the day with a manager approval, recorded on the Z event', async () => {
      sale()
      expect(h.days.closeDay(h.cashier)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'day.close' } } })
      const approval = await token('day.close')
      const z = ok(h.days.closeDay(h.cashier, approval))
      expect(z.data.zNumber).toBe(1)
      expect(h.eventRows('day.closed').at(-1)).toMatchObject({ user_id: h.cashier.userId, data: { zNumber: 1, overriddenBy: h.seeded.users.amine } })
    })

    it('an approval for another permission is refused, and a Z blocked by an open order does not spend it', async () => {
      sale()
      const open = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t6 }))
      ok(h.orders.addLine(h.cashier, open.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
      const wrong = await token('order.free_item')
      expect(h.days.closeDay(h.cashier, wrong)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'override_invalid' } } })
      const approval = await token('day.close')
      expect(code(h.days.closeDay(h.cashier, approval))).toBe('open_orders_exist')
      ok(h.orders.addPayment(h.cashier, open.id, { methodCode: 'cash', amountCents: 1200 }))
      ok(h.tickets.closeOrder(h.cashier, open.id))
      expect(ok(h.days.closeDay(h.cashier, approval)).data.ticketsCount).toBe(2)
    })
  })

  describe('creating a product from an unknown barcode (catalog.manage)', () => {
    it('a cashier needs a manager approval, spent once, recorded in the log', async () => {
      const catalog = createCatalogService({ db: h.t.db, uow: h.uow, settings: h.settings, overrides: h.users })
      const create = (barcode: string, approval?: Awaited<ReturnType<typeof token>>) =>
        catalog.quickCreateProduct(h.cashier, barcode, 'Stylo bleu', 350, h.fx.categories.plats, approval)
      expect(create('6111000000011')).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'catalog.manage' } } })
      const approval = await token('catalog.manage')
      expect(code(create('6111000000011', await token('day.close')))).toBe('forbidden')
      const created = ok(create('6111000000011', approval))
      expect(h.count('products', `id = '${created.id}'`)).toBe(1)
      expect(h.eventRows('product.quick_created').at(-1)).toMatchObject({ user_id: h.cashier.userId, data: { barcode: '6111000000011', overriddenBy: h.seeded.users.amine } })
      expect(code(create('6111000000028', approval))).toBe('forbidden')
      expect(h.count('products', "barcode = '6111000000028'")).toBe(0)
    })

    it('without the users service no approval can be offered', async () => {
      const catalog = createCatalogService({ db: h.t.db, uow: h.uow, settings: h.settings })
      const approval = await token('catalog.manage')
      expect(code(catalog.quickCreateProduct(h.cashier, '6111000000011', 'Stylo', 350, h.fx.categories.plats, approval))).toBe('forbidden')
      expect(ok(catalog.quickCreateProduct(h.manager, '6111000000011', 'Stylo', 350, h.fx.categories.plats)).id).toBeTruthy()
    })
  })
})
