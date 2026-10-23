import type { DayDto, TicketDto, ZData } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { Permission } from '@shared/permissions'
import type { Result } from '@shared/result'
import type { VatRow } from '@shared/vat'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { createTicketsRepo } from '../../../infrastructure/db/repos/tickets-repo'
import { computeZData } from '../days/z-data'
import { attemptSync, invalidInput } from '../users/outcome'
import { localDate, parsePeriod } from './period'

export const REPORT_GROUPS = ['day', 'product', 'category', 'user', 'payment'] as const
export type ReportGroup = (typeof REPORT_GROUPS)[number]

/** Reports are read with the permission of the X report: whoever may see the day's takings may see the history. */
export const REPORT_PERMISSION: Permission = 'report.x'

export interface ReportRow {
  /** The product, category, user or day id, the payment method code. */
  key: string
  label: LocalizedName
  ticketsCount?: number
  /** Payments of the method (credit notes subtracted). */
  count?: number
  qtyMilli?: number
  grossCents?: number
  discountsCents?: number
  /** TTC, credit notes subtracted. */
  totalCents: number
  /** `group=day` only. */
  dayNumber?: number
  zNumber?: number | null
  openedAt?: string
  open?: boolean
}

export interface SalesReport {
  from: string
  to: string
  group: ReportGroup
  /** Business days of the period (the one still open included). */
  daysCount: number
  /** The period's own X: the same figures as a Z, summed over the days. */
  totals: {
    ticketsCount: number
    creditsCount: number
    grossCents: number
    discountsCents: number
    totalCents: number
    byPayment: ZData['byPayment']
    byVat: VatRow[]
  }
  rows: ReportRow[]
}

interface DayRow {
  id: string
  number: number
  opened_at: string
  closed_at: string | null
}

const toDay = (row: DayRow): DayDto => ({ id: row.id, number: row.number, openedAt: row.opened_at, closedAt: row.closed_at })

/** The business days opened in the period, oldest first. */
export function daysOf(db: Database, startIso: string, endIso: string): DayDto[] {
  return (
    db.prepare('SELECT * FROM business_days WHERE opened_at >= ? AND opened_at < ? ORDER BY number').all(startIso, endIso) as DayRow[]
  ).map(toDay)
}

const zNumbers = (db: Database): Map<string, number> =>
  new Map((db.prepare('SELECT day_id, number FROM z_reports').all() as { day_id: string; number: number }[]).map((z) => [z.day_id, z.number]))

const figuresOf = (day: DayDto, tickets: TicketDto[], zNumber: number | null): ZData =>
  computeZData({ day, zNumber, closedAt: day.closedAt, tickets, voids: [], reprints: 0 })

/** Sums the products of the tickets: quantity and net money per product, credit notes subtracting the quantity. */
function byProduct(tickets: TicketDto[]): ReportRow[] {
  const rows = new Map<string, ReportRow>()
  for (const ticket of tickets) {
    const sign = ticket.kind === 'credit' ? -1 : 1
    for (const line of ticket.snapshot.lines) {
      let row = rows.get(line.productId)
      if (!row) {
        row = { key: line.productId, label: line.name, qtyMilli: 0, totalCents: 0 }
        rows.set(line.productId, row)
      }
      row.qtyMilli = (row.qtyMilli ?? 0) + sign * line.qtyMilli
      row.totalCents += line.netCents
    }
  }
  return [...rows.values()].sort((a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key))
}

/** Adds two lists keyed by `key`, in the order keys are first seen. */
function merge<T>(into: Map<string, T>, items: T[], keyOf: (item: T) => string, add: (target: T, item: T) => void): void {
  for (const item of items) {
    const key = keyOf(item)
    const found = into.get(key)
    if (found) add(found, item)
    else into.set(key, structuredClone(item))
  }
}

/**
 * The takings of a period, from the ticket snapshots only, with the rules of the Z (`computeZData`): credit notes
 * add their negated money and subtract their counts, so the report of one closed day equals its Z.
 */
export function buildSalesReport(db: Database, input: { from: string; to: string; group: ReportGroup }): SalesReport {
  const period = parsePeriod(input.from, input.to)
  const tickets = createTicketsRepo(db)
  const numbers = zNumbers(db)
  const days = daysOf(db, period.startIso, period.endIso)
  const perDay = days.map((day) => {
    const list = tickets.listOfDay(day.id)
    return { day, list, z: figuresOf(day, list, numbers.get(day.id) ?? null) }
  })

  const totals: SalesReport['totals'] = { ticketsCount: 0, creditsCount: 0, grossCents: 0, discountsCents: 0, totalCents: 0, byPayment: [], byVat: [] }
  const payments = new Map<string, ZData['byPayment'][number]>()
  const vat = new Map<string, VatRow>()
  const categories = new Map<string, ZData['byCategory'][number]>()
  const users = new Map<string, ZData['byUser'][number]>()
  for (const { z } of perDay) {
    totals.ticketsCount += z.ticketsCount
    totals.creditsCount += z.creditsCount
    totals.grossCents += z.grossCents
    totals.discountsCents += z.discountsCents
    totals.totalCents += z.totalCents
    merge(payments, z.byPayment, (p) => p.methodCode, (a, b) => ((a.count += b.count), (a.cents += b.cents)))
    merge(vat, z.byVat, (v) => String(v.rateBp), (a, b) => ((a.ttc += b.ttc), (a.ht += b.ht), (a.vat += b.vat)))
    merge(categories, z.byCategory, (c) => c.categoryId ?? '', (a, b) => ((a.qtyMilli += b.qtyMilli), (a.cents += b.cents)))
    merge(users, z.byUser, (u) => u.userId, (a, b) => ((a.ticketsCount += b.ticketsCount), (a.cents += b.cents)))
  }
  totals.byPayment = [...payments.values()].sort((a, b) => a.methodCode.localeCompare(b.methodCode))
  totals.byVat = [...vat.values()].sort((a, b) => b.rateBp - a.rateBp)

  let rows: ReportRow[]
  switch (input.group) {
    case 'day':
      rows = perDay.map(({ day, z }) => ({
        key: day.id,
        label: { fr: localDate(new Date(day.openedAt)) },
        dayNumber: day.number,
        zNumber: z.zNumber,
        openedAt: day.openedAt,
        open: day.closedAt === null,
        ticketsCount: z.ticketsCount,
        grossCents: z.grossCents,
        discountsCents: z.discountsCents,
        totalCents: z.totalCents
      }))
      break
    case 'product':
      rows = byProduct(perDay.flatMap(({ list }) => list))
      break
    case 'category':
      rows = [...categories.values()]
        .map((c) => ({ key: c.categoryId ?? '', label: c.name ?? { fr: '-' }, qtyMilli: c.qtyMilli, totalCents: c.cents }))
        .sort((a, b) => b.totalCents - a.totalCents)
      break
    case 'user':
      rows = [...users.values()]
        .map((u) => ({ key: u.userId, label: { fr: u.displayName }, ticketsCount: u.ticketsCount, totalCents: u.cents }))
        .sort((a, b) => b.totalCents - a.totalCents)
      break
    case 'payment':
      rows = totals.byPayment.map((p) => ({ key: p.methodCode, label: p.name, count: p.count, totalCents: p.cents }))
      break
  }
  return { from: period.from, to: period.to, group: input.group, daysCount: days.length, totals, rows }
}

export interface ZListItem {
  id: string
  dayId: string
  number: number
  dayNumber: number
  openedAt: string
  closedAt: string | null
  createdAt: string
  userId: string
  ticketsCount: number
  creditsCount: number
  grossCents: number
  discountsCents: number
  totalCents: number
}

/** The Z reports of the days opened in the period, newest first. */
export function listZReports(db: Database, input: { from: string; to: string }): ZListItem[] {
  const period = parsePeriod(input.from, input.to)
  const rows = db
    .prepare(
      `SELECT z.id, z.day_id, z.number, z.data_json, z.created_at, z.user_id, d.number AS day_number, d.opened_at, d.closed_at
       FROM z_reports z JOIN business_days d ON d.id = z.day_id
       WHERE d.opened_at >= ? AND d.opened_at < ? ORDER BY z.number DESC`
    )
    .all(period.startIso, period.endIso) as {
    id: string
    day_id: string
    number: number
    data_json: string
    created_at: string
    user_id: string
    day_number: number
    opened_at: string
    closed_at: string | null
  }[]
  return rows.map((row) => {
    const data = JSON.parse(row.data_json) as ZData
    return {
      id: row.id,
      dayId: row.day_id,
      number: row.number,
      dayNumber: row.day_number,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      userId: row.user_id,
      ticketsCount: data.ticketsCount,
      creditsCount: data.creditsCount,
      grossCents: data.grossCents,
      discountsCents: data.discountsCents,
      totalCents: data.totalCents
    }
  })
}

export interface ReportsUseCases {
  /** Needs `report.x`. `group`: one row per day, product, category, user or payment method. */
  sales(session: Session, query: { from: string; to: string; group: string }): Result<SalesReport>
  zList(session: Session, query: { from: string; to: string }): Result<ZListItem[]>
}

export function createReportsUseCases(deps: { db: Database }): ReportsUseCases {
  const { db } = deps
  return {
    sales: (session, query) =>
      attemptSync(() => {
        requirePermission(session, REPORT_PERMISSION)
        if (!(REPORT_GROUPS as readonly string[]).includes(query.group)) throw invalidInput('group', 'unknown grouping')
        return buildSalesReport(db, { from: query.from, to: query.to, group: query.group as ReportGroup })
      }),
    zList: (session, query) =>
      attemptSync(() => {
        requirePermission(session, REPORT_PERMISSION)
        return listZReports(db, query)
      })
  }
}
