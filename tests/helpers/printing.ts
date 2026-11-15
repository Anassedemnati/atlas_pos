import type { TicketSnapshot } from '../../src/shared/dto'
import type { Database } from '../../src/main/infrastructure/db/connection'
import type { Discount } from '../../src/main/domain/order/discount'
import type { StoredLine, StoredOrder } from '../../src/main/infrastructure/db/repos/orders-repo'
import { computeTotals } from '../../src/main/domain/order/totals'
import { creditSnapshot, saleSnapshot } from '../../src/main/application/usecases/tickets/snapshot'
import type { PrinterRow } from '../../src/main/infrastructure/printing/types'

export const BUSINESS = {
  raisonSociale: 'Dar Atlas SARL',
  nomCommercial: 'Restaurant Dar Atlas',
  adresse: '12 rue Tarik',
  ville: 'Marrakech',
  telephone: '0524000000',
  ice: '001234567000089',
  if: '12345678',
  rc: '98765',
  patente: '45678901'
}

export interface SampleLine {
  name?: { fr: string; ar?: string; en?: string }
  qtyMilli?: number
  unitPriceCents: number
  vatBp?: number
  modifiers?: { name: string; deltaCents?: number }[]
  discount?: Discount | null
  free?: boolean
  note?: string
}

let counter = 0

/** An order with these lines, priced and frozen exactly as closing a ticket does. */
export function sampleSale(
  lines: SampleLine[],
  over: {
    lang?: 'fr' | 'ar' | 'en'
    discount?: Discount | null
    payments?: { methodCode: string; amountCents: number; tenderedCents: number }[]
    table?: string | null
    covers?: number
    orderNumber?: number | null
    type?: StoredOrder['type']
    header?: string
    footer?: string
    closedAt?: string
  } = {}
): TicketSnapshot {
  const storedLines: StoredLine[] = lines.map((l, i) => ({
    id: `line-${++counter}`,
    seq: i + 1,
    productId: `product-${i}`,
    name: l.name ?? { fr: `Article ${i + 1}` },
    qtyMilli: l.qtyMilli ?? 1000,
    unitPriceCents: l.unitPriceCents,
    vatBp: l.vatBp ?? 1000,
    modifiers: (l.modifiers ?? []).map((m, k) => ({ id: `m${k}`, name: { fr: m.name }, priceDeltaCents: m.deltaCents ?? 0 })),
    note: l.note ?? '',
    course: 0,
    status: 'active',
    sentAt: null,
    discount: l.discount ?? null,
    free: l.free ?? false,
    voidReason: '',
    freeReason: l.free ? 'offert' : '',
    userId: 'u-amine',
    createdAt: '2026-10-22T10:00:00.000Z'
  }))
  const total = computeTotals(storedLines, over.discount ?? null).total
  const order: StoredOrder = {
    id: 'order-1',
    dayId: 'day-1',
    type: over.type ?? 'dine_in',
    tableId: over.table === null ? null : 't4',
    tableLabel: over.table === null ? null : (over.table ?? 'T4'),
    covers: over.covers ?? 3,
    orderNumber: over.orderNumber ?? null,
    status: 'open',
    userId: 'u-amine',
    customerId: null,
    openedAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    note: '',
    discount: over.discount ?? null,
    ownGrantBp: 0,
    approvedTicketBp: 0,
    approvedCents: 0,
    lines: storedLines,
    payments: (over.payments ?? [{ methodCode: 'cash', amountCents: total, tenderedCents: total }]).map((p, i) => ({
      id: `pay-${i}`,
      ...p,
      createdAt: '2026-10-22T10:05:00.000Z',
      userId: 'u-amine'
    }))
  }
  return saleSnapshot({
    number: 123,
    label: '000123',
    closedAt: over.closedAt ?? new Date(2026, 9, 22, 11, 15).toISOString(),
    dayNumber: 7,
    business: BUSINESS,
    receipt: { lang: over.lang ?? 'fr', header: over.header ?? '', footer: over.footer ?? 'Merci de votre visite !' },
    user: { id: 'u-amine', displayName: 'Amine' },
    order,
    table: order.tableId ? { id: order.tableId, label: order.tableLabel! } : null,
    customer: undefined,
    categoryOf: () => undefined,
    methodName: (code) => (code === 'cash' ? { fr: 'Espèces', ar: 'نقداً', en: 'Cash' } : { fr: 'Carte bancaire', ar: 'بطاقة', en: 'Card' })
  })
}

/** The credit note of a sale, as cancelling it writes it. */
export function sampleCredit(sale: TicketSnapshot): TicketSnapshot {
  return creditSnapshot(
    sale,
    {
      number: 7,
      label: 'AV-000007',
      closedAt: new Date(2026, 9, 22, 12, 0).toISOString(),
      dayNumber: 7,
      business: sale.business,
      receipt: sale.receipt,
      user: { id: 'u-sara', displayName: 'Sara' }
    },
    { ticketId: 'ticket-1', reason: 'Erreur de caisse' }
  )
}

export const printer = (over: Partial<PrinterRow> = {}): PrinterRow => ({
  id: 'p-receipt',
  name: 'Caisse',
  kind: 'virtual',
  address: '',
  widthMm: 80,
  lang: 'fr',
  raster: false,
  role: 'receipt',
  active: true,
  ...over
})

// -- database fixtures ---------------------------------------------------------------------------------

/** Inserts a printer row (see `printer()` for the defaults). */
export function addPrinter(db: Database, over: Partial<PrinterRow> = {}): PrinterRow {
  const p = printer(over)
  db.prepare('INSERT INTO printers (id, name, kind, address, width_mm, lang, raster, role, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    p.id,
    p.name,
    p.kind,
    p.address,
    p.widthMm,
    p.lang,
    p.raster ? 1 : 0,
    p.role,
    p.active ? 1 : 0
  )
  return p
}

/** Sends the lines of a category to a printer (`category_printers`). */
export function routeCategory(db: Database, categoryId: string, printerId: string): void {
  db.prepare('INSERT INTO category_printers (category_id, printer_id) VALUES (?, ?)').run(categoryId, printerId)
}

export interface JobRowView {
  id: string
  printer_id: string
  kind: string
  status: string
  attempts: number
  error: string | null
  payload: unknown
}

/** The `print_jobs` rows in insertion order. */
export function jobRows(db: Database): JobRowView[] {
  return (
    db.prepare('SELECT id, printer_id, kind, status, attempts, error, payload_json FROM print_jobs ORDER BY rowid').all() as (Omit<JobRowView, 'payload'> & {
      payload_json: string
    })[]
  ).map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) }))
}
