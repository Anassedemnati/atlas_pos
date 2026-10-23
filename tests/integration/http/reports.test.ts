import { existsSync } from 'node:fs'
import type { BackupStatusDto, ZData } from '../../../src/shared/dto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SalesReport, ZListItem } from '../../../src/main/application/usecases/reports'
import { localDate } from '../../../src/main/application/usecases/reports/period'
import { body, startHttp, type Http } from './harness'

let h: Http
let z: ZData
const today = localDate(new Date())

beforeAll(async () => {
  h = await startHttp()
  expect((await h.login()).statusCode).toBe(200)
  // Two sales (one paid in cash, one in card), a credit note for the second, then the Z.
  const session = await h.till()
  const services = h.runtime.services()!
  const product = plainProduct(services)
  const sale = (method: string, qty: number) => {
    const order = ok(services.orders.openOrder(session, { type: 'counter' }))
    ok(services.orders.addLine(session, order.id, { productId: product.id, qtyMilli: qty * 1000, modifierIds: [], note: '' }))
    const due = ok(services.orders.getOrder(session, order.id)).dueCents
    ok(services.orders.addPayment(session, order.id, { methodCode: method, amountCents: due, tenderedCents: due }))
    return ok(services.tickets.closeOrder(session, order.id))
  }
  sale('cash', 2)
  const second = sale('card', 1)
  sale('cash', 3)
  ok(services.tickets.cancelTicket(session, second.id, 'erreur de saisie'))
  z = ok(services.days.closeDay(session)).data
})
afterAll(async () => {
  await h.close()
})

/** A product a counter sale can take as it is: no modifiers, not a set menu, not by weight. */
function plainProduct(services: NonNullable<ReturnType<Http['runtime']['services']>>) {
  const { products, menus } = services.catalog.listCatalog()
  return products.find((p) => p.active && p.modifierGroupIds.length === 0 && !p.soldByWeight && p.priceCents > 0 && !menus.some((m) => m.productId === p.id))!
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}`)
  return result.value
}

const report = async (query: string) => body<{ value: SalesReport }>(await h.api('GET', `/api/reports?${query}`)).value

describe('reports', () => {
  it('a report for a day equals the Z of that day', async () => {
    const daily = await report(`from=${today}&to=${today}&group=day`)
    expect(daily.daysCount).toBe(1)
    expect(daily.rows).toHaveLength(1)
    const row = daily.rows[0]!
    expect(row).toMatchObject({ zNumber: z.zNumber, ticketsCount: z.ticketsCount, grossCents: z.grossCents, discountsCents: z.discountsCents, totalCents: z.totalCents, open: false })
    expect(daily.totals).toMatchObject({ ticketsCount: z.ticketsCount, creditsCount: z.creditsCount, grossCents: z.grossCents, discountsCents: z.discountsCents, totalCents: z.totalCents })
    expect(daily.totals.byPayment).toEqual(z.byPayment)
    expect(daily.totals.byVat).toEqual(z.byVat)
    // Not a degenerate case: three sales, one cancelled by a credit note.
    expect(z.ticketsCount).toBe(3)
    expect(z.creditsCount).toBe(1)
    expect(z.totalCents).toBeGreaterThan(0)
  })

  it('groups by payment, user and category with the same totals; by product from the lines', async () => {
    const payment = await report(`from=${today}&to=${today}&group=payment`)
    expect(payment.rows.map((r) => [r.key, r.count, r.totalCents])).toEqual(z.byPayment.map((p) => [p.methodCode, p.count, p.cents]))
    const user = await report(`from=${today}&to=${today}&group=user`)
    expect(user.rows.map((r) => [r.label.fr, r.ticketsCount, r.totalCents])).toEqual(z.byUser.map((u) => [u.displayName, u.ticketsCount, u.cents]))
    const category = await report(`from=${today}&to=${today}&group=category`)
    expect(category.rows.reduce((sum, r) => sum + r.totalCents, 0)).toBe(z.totalCents)
    const product = await report(`from=${today}&to=${today}&group=product`)
    expect(product.rows.reduce((sum, r) => sum + r.totalCents, 0)).toBe(z.totalCents)
    // 2 + 1 + 3 sold, the single one cancelled.
    expect(product.rows[0]!.qtyMilli).toBe(5000)
  })

  it('is empty outside the days that were opened in the period, and refuses bad input', async () => {
    const past = await report('from=2020-01-01&to=2020-01-31&group=day')
    expect(past).toMatchObject({ daysCount: 0, rows: [], totals: { totalCents: 0, ticketsCount: 0 } })
    for (const query of ['from=2026-02-30&to=2026-03-01', 'from=2026-03-02&to=2026-03-01', 'from=2020-01-01&to=2026-03-01', `from=${today}&to=${today}&group=nope`, 'from=hier&to=demain']) {
      expect((await h.api('GET', `/api/reports?${query}`)).statusCode, query).toBe(400)
    }
  })

  it('lists the Z reports of the period', async () => {
    const list = body<{ value: ZListItem[] }>(await h.api('GET', `/api/reports/z?from=${today}&to=${today}`)).value
    expect(list).toMatchObject([{ number: z.zNumber, totalCents: z.totalCents, ticketsCount: 3, creditsCount: 1 }])
  })

  it('exports the report as CSV (decimal comma, BOM) and XLSX', async () => {
    const csv = await h.api('GET', `/api/reports/export?from=${today}&to=${today}&group=payment&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toContain(`rapport-paiements-${today}-${today}.csv`)
    expect(csv.body.startsWith('﻿Mode de paiement;Paiements;Total TTC (DH)')).toBe(true)
    const lines = csv.body.trim().split('\r\n')
    const total = lines[lines.length - 1]!
    expect(total).toBe(`Total;;${(z.totalCents / 100).toString().replace('.', ',')}`)
    const xlsx = await h.api('GET', `/api/reports/export?from=${today}&to=${today}&group=day&format=xlsx`)
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK')
    expect((await h.api('GET', `/api/reports/export?from=${today}&to=${today}&group=day&format=pdf`)).statusCode).toBe(400)
  })

  it('needs the report permission: a user who may sign in but not read reports gets 403 on them', async () => {
    const manager = await h.till()
    const services = h.runtime.services()!
    const profile = ok(services.users.saveProfile(manager, { name: { fr: 'Accès seul' }, permissions: ['backoffice.login'], maxDiscountBp: 0 }))
    ok(await services.users.saveUser(manager, { displayName: 'Lecteur', profileId: profile.id, pin: '5678', username: 'lecteur', password: 'Lecteur-Pass-2026' }))
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lecteur', password: 'Lecteur-Pass-2026' } })
    expect(login.statusCode).toBe(200)
    const cookie = `atlas_sid=${login.cookies[0]!.value}`
    for (const url of [`/api/reports?from=${today}&to=${today}`, `/api/reports/z?from=${today}&to=${today}`, `/api/reports/export?from=${today}&to=${today}&group=day&format=csv`, '/api/journal']) {
      const response = await h.app.inject({ method: 'GET', url, headers: { cookie } })
      expect(response.statusCode, url).toBe(403)
      expect(body(response)).toMatchObject({ error: { code: 'forbidden' } })
    }
    // The dashboard still opens, without figures.
    const dashboard = await h.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } })
    expect(dashboard.statusCode).toBe(200)
    expect(body<{ value: { today: unknown } }>(dashboard).value.today).toBeNull()
  })
})

describe('journal and dashboard', () => {
  it('reads the event log, newest first, by type or family', async () => {
    const all = body<{ value: { lines: { type: string; userName: string | null }[]; types: string[] } }>(await h.api('GET', '/api/journal?limit=500')).value
    expect(all.types).toEqual(expect.arrayContaining(['user.login', 'day.closed']))
    expect(all.lines.length).toBeGreaterThan(5)
    const closed = body<{ value: { lines: { type: string; userName: string | null }[] } }>(await h.api('GET', '/api/journal?type=day.closed')).value
    expect(closed.lines).toMatchObject([{ type: 'day.closed', userName: 'Karim' }])
    const family = body<{ value: { lines: { type: string }[] } }>(await h.api('GET', '/api/journal?type=user')).value
    expect(family.lines.length).toBeGreaterThan(0)
    expect(family.lines.every((l) => l.type.startsWith('user.'))).toBe(true)
    expect((await h.api('GET', '/api/journal?limit=0')).statusCode).toBe(400)
    expect((await h.api('GET', '/api/journal?limit=9999')).statusCode).toBe(400)
    expect((await h.api('GET', '/api/journal/errors')).statusCode).toBe(200)
  })

  it('shows the day, the backups and the printers on the dashboard', async () => {
    const dashboard = body<{ value: { day: unknown; today: ZData | null; backup: BackupStatusDto | null; printers: { name: string }[] } }>(await h.api('GET', '/api/dashboard')).value
    // The day was closed by the Z: nothing is open until the next sale.
    expect(dashboard.day).toBeNull()
    expect(dashboard.today).toBeNull()
    expect(dashboard.backup).toMatchObject({ overall: expect.stringMatching(/ok|warning|error/) })
    expect(dashboard.printers.map((p) => p.name)).toEqual(expect.arrayContaining(['Caisse', 'Cuisine']))
  })

  it('shows the takings of the open day (the X report)', async () => {
    const session = await h.till()
    const services = h.runtime.services()!
    const product = plainProduct(services)
    const order = ok(services.orders.openOrder(session, { type: 'counter' }))
    ok(services.orders.addLine(session, order.id, { productId: product.id, qtyMilli: 1000, modifierIds: [], note: '' }))
    const due = ok(services.orders.getOrder(session, order.id)).dueCents
    ok(services.orders.addPayment(session, order.id, { methodCode: 'cash', amountCents: due, tenderedCents: due }))
    ok(services.tickets.closeOrder(session, order.id))
    const dashboard = body<{ value: { day: { closedAt: null }; today: ZData } }>(await h.api('GET', '/api/dashboard')).value
    expect(dashboard.day.closedAt).toBeNull()
    expect(dashboard.today).toMatchObject({ ticketsCount: 1, totalCents: due, zNumber: null })
    // The open day is in the report too, flagged open.
    const daily = await report(`from=${today}&to=${today}&group=day`)
    expect(daily.rows.map((r) => r.open)).toEqual([false, true])
    expect(daily.totals.totalCents).toBe(z.totalCents + due)
    expect(existsSync(h.paths.root)).toBe(true)
  })
})
