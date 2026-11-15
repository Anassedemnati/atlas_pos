import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderDto } from '../../../src/shared/dto'
import { createPrintService, type PrintService } from '../../../src/main/infrastructure/printing/service'
import type { Bitmap, DotWidth } from '../../../src/main/infrastructure/printing/types'
import { paperText } from '../../helpers/escpos-decode'
import { addPrinter, jobRows, routeCategory } from '../../helpers/printing'
import { code, ok, salesHarness, type SalesHarness } from '../../helpers/sales'

/**
 * The print queue behind the real use cases: orders, kitchen sends, tickets and Z closure queue their jobs in
 * their own transactions, and a worker prints them on virtual printers (folders), so the paper can be read back.
 */
describe('printing behind the use cases', () => {
  let h: SalesHarness
  let service: PrintService
  let dir: string
  let rasterized: { html: string; widthDots: DotWidth }[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-flow-'))
    rasterized = []
    h = salesHarness(undefined, {
      spooler: ({ t, clock, bus, settings }) => {
        service = createPrintService({
          db: t.db,
          clock,
          eventBus: bus,
          settings,
          printsDir: join(dir, 'prints'),
          rasterize: async (html, widthDots): Promise<Bitmap> => {
            rasterized.push({ html, widthDots })
            return { width: widthDots, height: 8, data: new Uint8Array((widthDots / 8) * 8).fill(0xf0) }
          },
          log: () => undefined,
          backoffMs: [0, 0, 0],
          networkTimeoutMs: 500
        })
        return service.queue
      }
    })
  })
  afterEach(() => {
    service.queue.stop()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  const files = (ext: string): string[] => {
    try {
      return readdirSync(join(dir, 'prints'))
        .filter((f) => f.endsWith(`.${ext}`))
        .sort()
    } catch {
      return []
    }
  }
  /** The paper of every job a virtual printer got, text of each. */
  const paper = (slug: string): string[] =>
    files('bin')
      .filter((f) => f.includes(`-${slug}`))
      .map((f) => paperText(readFileSync(join(dir, 'prints', f))))

  /** Lets the worker finish, then moves the clock so the next file name is its own. */
  async function settle(): Promise<void> {
    await service.queue.idle()
    h.clock.advance(1000)
  }

  const add = (orderId: string, productId: string, qtyMilli = 1000, modifierIds: string[] = []): OrderDto =>
    ok(h.orders.addLine(h.cashier, orderId, { productId, qtyMilli, modifierIds, note: '' }))

  const openT4 = (): OrderDto => ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))

  /** Caisse (receipt), Cuisine (kitchen) and Bar (bar, routed the Boissons category), all virtual. */
  function installPrinters(): void {
    addPrinter(h.t.db, { id: 'p1-caisse', name: 'Caisse', role: 'receipt', kind: 'virtual' })
    addPrinter(h.t.db, { id: 'p2-cuisine', name: 'Cuisine', role: 'kitchen', kind: 'virtual' })
    addPrinter(h.t.db, { id: 'p3-bar', name: 'Bar', role: 'bar', kind: 'virtual' })
    routeCategory(h.t.db, h.fx.categories.boissons, 'p3-bar')
  }

  it('a sale goes through with no printer configured at all, and prints nothing', async () => {
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 7000 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    expect(ticket.label).toBe('000001')
    expect(jobRows(h.t.db)).toEqual([])
    expect(files('bin')).toEqual([])
  })

  it('closing a cash sale prints the receipt, then pulses the drawer', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine, 2000)
    add(order.id, h.fx.products.the, 3000)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 20000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()

    const [receipt, drawer] = paper('caisse')
    expect(receipt).toContain('Restaurant Dar Atlas')
    expect(receipt).toContain('Ticket N° 000001')
    expect(receipt).toContain('Table : T4')
    expect(receipt).toContain('2 x Tajine')
    expect(receipt).toContain('3 x Thé à la menthe')
    expect(receipt).toMatch(/TOTAL TTC\s+176,00 DH/)
    expect(receipt).toMatch(/Espèces\s+200,00/)
    expect(receipt).toMatch(/Rendu\s+24,00/)
    expect(receipt).not.toContain('DUPLICATA')
    // the drawer job is the pulse alone
    expect(drawer).toBe('')
    expect(readFileSync(join(dir, 'prints', files('bin').filter((f) => f.includes('-caisse'))[1]!)).toString('hex')).toBe('1b40' + '1b700019fa')
    expect(jobRows(h.t.db).filter((r) => r.printer_id === 'p1-caisse').map((r) => [r.kind, r.status])).toEqual([
      ['receipt', 'done'],
      ['drawer', 'done']
    ])
  })

  it('a card sale does not open the drawer', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    expect(jobRows(h.t.db).filter((r) => r.kind === 'drawer')).toEqual([])
  })

  it('sends each kitchen line to the printer of its category: Plats to Cuisine, Boissons to Bar', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine, 2000)
    add(order.id, h.fx.products.the)
    add(order.id, h.fx.products.eau)
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    await settle()

    const cuisine = paper('cuisine')
    const bar = paper('bar')
    expect(cuisine).toHaveLength(1)
    expect(bar).toHaveLength(1)
    expect(cuisine[0]).toContain('Table T4')
    expect(cuisine[0]).toContain('2 x Tajine')
    expect(cuisine[0]).not.toContain('Thé')
    expect(bar[0]).toContain('1 x Thé à la menthe')
    expect(bar[0]).toContain('1 x Eau')
    expect(bar[0]).not.toContain('Tajine')
    expect(cuisine[0]).toContain('Couverts : 2')
    expect(cuisine[0]).toContain('Serveur : Sara El Idrissi')
    expect(jobRows(h.t.db).filter((r) => r.kind === 'kitchen').map((r) => r.printer_id)).toEqual(['p2-cuisine', 'p3-bar'])
  })

  it('a category with no route goes to the first kitchen printer', async () => {
    addPrinter(h.t.db, { id: 'p2-cuisine', name: 'Cuisine', role: 'kitchen', kind: 'virtual' })
    addPrinter(h.t.db, { id: 'p3-cuisine2', name: 'Cuisine 2', role: 'kitchen', kind: 'virtual' })
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.the)
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    await settle()
    expect(paper('cuisine-2')).toEqual([])
    expect(paper('cuisine')).toHaveLength(1)
  })

  it('prints the kitchen ticket as it was sent: a retry or a reprint does not follow later changes', async () => {
    installPrinters()
    const order = openT4()
    add(order.id, h.fx.products.tajine, 2000)
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    // The worker has not run yet. The order changes behind the queued ticket.
    h.t.db.prepare("UPDATE order_lines SET name_json = '{\"fr\":\"Plat modifié\"}'").run()
    h.t.db.prepare('UPDATE orders SET covers = 9').run()
    service.queue.start()
    await settle()
    const ticket = paper('cuisine')[0]!
    expect(ticket).toContain('2 x Tajine')
    expect(ticket).toContain('Couverts : 2')
    expect(ticket).not.toContain('Plat modifié')
  })

  it('voiding a sent line prints an ANNULÉ ticket on the printer that got it', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    const withLines = add(order.id, h.fx.products.the)
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    await settle()
    h.clock.advance(25 * 60 * 1000)
    ok(h.orders.voidLine(h.manager, order.id, withLines.lines[0]!.id, 'Erreur de saisie'))
    await settle()
    const bar = paper('bar')
    expect(bar).toHaveLength(2)
    // each ticket carries the time it was queued: the send at 11:00, the cancellation 25 minutes later
    expect(bar[0]).toContain('22/10/2026 11:00')
    expect(bar[1]).toContain('22/10/2026 11:25')
    expect(bar[1]).toContain('*** ANNULÉ ***')
    expect(bar[1]).toContain('1 x Thé à la menthe')
    expect(paper('cuisine')).toEqual([])
  })

  it('a kitchen ticket that may have printed is sent again marked RÉIMPRESSION, and an uncertain receipt is left to reprintTicket', async () => {
    installPrinters()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.orders.sendToKitchen(h.cashier, order.id))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    // A crash left both jobs printing.
    h.t.db.prepare("UPDATE print_jobs SET status = 'printing', attempts = 1").run()
    service.queue.start()
    await settle()
    const uncertain = service.queue.list()
    expect(uncertain.map((j) => j.kind).sort()).toEqual(['kitchen', 'receipt'])
    expect(paper('cuisine')).toEqual([])

    const receipt = uncertain.find((j) => j.kind === 'receipt')!
    expect(service.queue.reprintJob(receipt.id)).toMatchObject({ ok: false, error: { code: 'print_job_not_reprintable', params: { reason: 'use_ticket_reprint' } } })
    // the cashier uses the ticket reprint (DUPLICATA, counted) instead
    ok(h.tickets.reprintTicket(h.cashier, ticket.id))
    await settle()
    expect(paper('caisse')[0]).toContain('DUPLICATA')

    const kitchen = uncertain.find((j) => j.kind === 'kitchen')!
    expect(service.queue.reprintJob(kitchen.id)).toMatchObject({ ok: true })
    await settle()
    expect(paper('cuisine')).toHaveLength(1)
    expect(paper('cuisine')[0]).toContain('*** RÉIMPRESSION ***')
    expect(paper('cuisine')[0]).toContain('1 x Tajine')
  })

  it('a reprint is marked DUPLICATA', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    ok(h.tickets.reprintTicket(h.cashier, ticket.id))
    await settle()
    const [original, copy] = paper('caisse')
    expect(original).not.toContain('DUPLICATA')
    expect(copy).toContain('DUPLICATA')
    expect(copy).toContain('Ticket N° 000001')
  })

  it('a credit note prints its own receipt', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    ok(h.tickets.cancelTicket(h.manager, ticket.id, 'Client parti'))
    await settle()
    const credit = paper('caisse')[1]!
    expect(credit).toContain('Avoir N° AV-000001')
    expect(credit).toContain('Réf. ticket 000001')
    expect(credit).toContain('Motif : Client parti')
    expect(credit).toContain('-70,00 DH')
  })

  it('closing the day prints the Z report', async () => {
    installPrinters()
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    ok(h.days.closeDay(h.manager))
    await settle()
    const z = paper('caisse').find((text) => text.includes('RAPPORT Z'))!
    expect(z).toContain('RAPPORT Z N° 1')
    expect(z).toMatch(/Tickets\s+1/)
    expect(z).toMatch(/Total\s+70,00 DH/)
    expect(z).toMatch(/Carte bancaire \(1\)\s+70,00/)
  })

  it('an Arabic receipt is rasterised, and the virtual printer keeps the bytes and a PNG', async () => {
    installPrinters()
    h.uow.run((tx) => h.settings.set(tx, 'receipt.lang', 'ar'))
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()
    expect(rasterized).toHaveLength(1)
    expect(rasterized[0]!.widthDots).toBe(576)
    expect(rasterized[0]!.html).toContain('dir="rtl"')
    expect(rasterized[0]!.html).toContain('طاجين')
    expect(rasterized[0]!.html).toContain('تذكرة رقم')
    expect(files('png')).toHaveLength(1)
    const receipts = files('bin').filter((f) => f.includes('-caisse'))
    expect(receipts).toHaveLength(1)
    const job = readFileSync(join(dir, 'prints', receipts[0]!))
    expect(job.subarray(0, 2).toString('hex')).toBe('1b40')
    expect(job.includes(Buffer.from('1d763000', 'hex'))).toBe(true)
    expect(job.subarray(-4).toString('hex')).toBe('1d564200')
  })

  it('a printer that is down does not undo or block the sale: the job fails and waits for a decision, then reprints', async () => {
    addPrinter(h.t.db, { id: 'p1-caisse', name: 'Caisse', role: 'receipt', kind: 'network', address: '127.0.0.1:1' })
    service.queue.start()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
    await settle()

    expect(h.count('tickets')).toBe(1)
    expect(service.queue.list()).toMatchObject([{ kind: 'receipt', status: 'failed', attempts: 4, printerName: 'Caisse' }])
    expect(service.queue.list()[0]!.error).toMatch(/ECONNREFUSED/)

    // The technician fixes the printer, and the cashier reprints the failed job.
    h.t.db.prepare("UPDATE printers SET kind = 'virtual', address = ''").run()
    expect(service.queue.reprintJob(service.queue.list()[0]!.id)).toMatchObject({ ok: true })
    await settle()
    expect(service.queue.list()).toEqual([])
    expect(paper('caisse')[0]).toContain(`Ticket N° ${ticket.label}`)
  })

  it('a job left printing by a crash is surfaced after the restart and not printed again silently', async () => {
    installPrinters()
    const order = openT4()
    add(order.id, h.fx.products.tajine)
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 7000 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    h.t.db.prepare("UPDATE print_jobs SET status = 'printing', attempts = 1 WHERE kind = 'receipt'").run()
    service.queue.start()
    await settle()
    expect(service.queue.list()).toMatchObject([{ kind: 'receipt', status: 'uncertain' }])
    expect(paper('caisse')).toEqual([])
  })

  describe('jobs of other kinds', () => {
    /** A closed ticket and an invoice row made from it (Task 14 writes these; the print job only reads the row). */
    const invoiceOf = (): string => {
      const order = openT4()
      add(order.id, h.fx.products.tajine, 2000)
      ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'card', amountCents: 14000 }))
      const ticket = ok(h.tickets.closeOrder(h.cashier, order.id))
      h.t.db
        .prepare('INSERT INTO invoices (id, number_label, ticket_id, customer_json, created_at, user_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          'inv-1',
          'F-2026-00001',
          ticket.id,
          JSON.stringify({ name: 'Karim', companyName: 'Alaoui SARL', address: 'Casablanca', ice: '002233445000011' }),
          h.clock.now().toISOString(),
          h.manager.userId,
          JSON.stringify(ticket.snapshot)
        )
      return 'inv-1'
    }
    const enqueueInvoice = (target: { printerId: string }): void =>
      h.uow.run((tx) => service.queue.enqueue(tx, { target, kind: 'invoice', payload: { invoiceId: 'inv-1' } }))

    it('an invoice goes to a printer that takes documents, as its A4 page', async () => {
      installPrinters()
      invoiceOf()
      service.queue.start()
      await settle()
      enqueueInvoice({ printerId: 'p1-caisse' })
      await settle()
      const page = readFileSync(join(dir, 'prints', files('html')[0]!), 'utf8')
      expect(page).toContain('F-2026-00001')
      expect(page).toContain('Alaoui SARL')
      expect(page).toContain('002233445000011')
      expect(page).toMatch(/size:\s*A4/)
    })

    it('an invoice for a thermal printer is refused for good, not retried', async () => {
      addPrinter(h.t.db, { id: 'p1-net', name: 'Réseau', role: 'receipt', kind: 'network', address: '127.0.0.1:1' })
      invoiceOf()
      service.queue.start()
      await settle()
      enqueueInvoice({ printerId: 'p1-net' })
      await settle()
      expect(jobRows(h.t.db).filter((r) => r.kind === 'invoice')).toMatchObject([
        { status: 'failed', attempts: 4, error: expect.stringContaining('html_not_supported') }
      ])
    })

    it('a pre-bill with no readable content fails for good, with that reason', async () => {
      installPrinters()
      service.queue.start()
      h.uow.run((tx) => service.queue.enqueue(tx, { target: { role: 'receipt' }, kind: 'prebill', payload: { orderId: 'x' } }))
      await settle()
      expect(jobRows(h.t.db)).toMatchObject([{ kind: 'prebill', status: 'failed', error: expect.stringContaining('payload_unreadable') }])
    })
  })

  describe('testPrint', () => {
    it('prints the test page on the printer right now, outside the queue', async () => {
      installPrinters()
      expect(await service.testPrint('p1-caisse')).toEqual({ ok: true, value: null })
      const page = paper('caisse')[0]!
      expect(page).toContain("TEST D'IMPRESSION")
      expect(page).toContain('Restaurant Dar Atlas')
      expect(page).toContain('Imprimante : Caisse')
      expect(page).toContain("Test d'impression OK")
      expect(h.count('print_jobs')).toBe(0)
    })

    it('says so when the printer does not exist or cannot be reached', async () => {
      expect(code(await service.testPrint('nope'))).toBe('printer_not_found')
      addPrinter(h.t.db, { id: 'p9', name: 'Hors ligne', role: 'kitchen', kind: 'network', address: '127.0.0.1:1' })
      const result = await service.testPrint('p9')
      expect(code(result)).toBe('print_failed')
      expect(!result.ok && result.error.params?.['message']).toMatch(/ECONNREFUSED/)
    })
  })
})
