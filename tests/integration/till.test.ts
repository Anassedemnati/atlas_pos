import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTillService, type TillService } from '../../src/main/application/usecases/till'
import { createPrintService, type PrintService } from '../../src/main/infrastructure/printing/service'
import { paperText } from '../helpers/escpos-decode'
import { addPrinter } from '../helpers/printing'
import { code, ok, salesHarness, type SalesHarness } from '../helpers/sales'

describe('till use cases (order list, pre-bill, ticket search, Z history)', () => {
  let h: SalesHarness
  let service: PrintService
  let till: TillService
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-till-'))
    h = salesHarness(undefined, {
      spooler: ({ t, clock, bus, settings }) => {
        service = createPrintService({
          db: t.db,
          clock,
          eventBus: bus,
          settings,
          printsDir: join(dir, 'prints'),
          rasterize: async () => {
            throw new Error('no rendering')
          },
          log: () => undefined,
          backoffMs: [0, 0, 0]
        })
        return service.queue
      }
    })
    till = createTillService({ db: h.t.db, uow: h.uow, settings: h.settings, spooler: service.queue, clock: h.clock, overrides: h.users })
    addPrinter(h.t.db, { id: 'p1-caisse', name: 'Caisse', role: 'receipt', kind: 'virtual' })
  })
  afterEach(() => {
    service.queue.stop()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  const printed = (): string[] =>
    readdirSync(join(dir, 'prints'))
      .filter((f) => f.endsWith('.bin'))
      .map((f) => paperText(readFileSync(join(dir, 'prints', f))))

  it('lists the open orders with their total, and the pre-bill marks the order and prints ADDITION without a ticket number', async () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 3 }))
    expect(code(till.printPrebill(h.cashier, order.id))).toBe('order_empty')
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.tajine, qtyMilli: 2000, modifierIds: [], note: '' }))
    const before = ok(till.listOrders(h.cashier))
    expect(before).toMatchObject([{ id: order.id, tableLabel: expect.any(String), covers: 3, linesCount: 1, billRequested: false }])
    expect(before[0]!.totalCents).toBeGreaterThan(0)

    ok(till.printPrebill(h.cashier, order.id))
    expect(ok(till.listOrders(h.cashier))[0]).toMatchObject({ id: order.id, billRequested: true })
    service.queue.start()
    await service.queue.idle()
    const [paper] = printed()
    expect(paper).toContain('ADDITION')
    expect(paper).not.toContain('Ticket N')
    expect(paper).not.toContain('Rendu')
  })

  it('finds tickets by number and flags the cancelled ones; the Z history lists the closed days', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'counter' }))
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.tajine, qtyMilli: 1000, modifierIds: [], note: '' }))
    const due = ok(h.orders.getOrder(h.cashier, order.id)).dueCents
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: due, tenderedCents: due }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(ok(till.listTickets(h.cashier, {}))).toMatchObject([{ label: '000001', cancelled: false, orderType: 'counter' }])
    expect(ok(till.listTickets(h.cashier, { q: '0001' }))).toHaveLength(1)
    expect(ok(till.listTickets(h.cashier, { q: '77' }))).toHaveLength(0)
    ok(h.tickets.cancelTicket(h.manager, ticket.id, 'erreur'))
    const rows = ok(till.listTickets(h.cashier, {}))
    expect(rows.map((r) => [r.label, r.cancelled])).toEqual([
      ['AV-000001', false],
      ['000001', true]
    ])
    expect(rows[0]).toMatchObject({ kind: 'credit', refLabel: '000001' })

    expect(ok(till.zHistory(h.manager))).toEqual([])
    ok(h.days.closeDay(h.manager))
    expect(ok(till.zHistory(h.manager))).toMatchObject([{ zNumber: 1, dayNumber: 1, ticketsCount: 1 }])
  })
})
