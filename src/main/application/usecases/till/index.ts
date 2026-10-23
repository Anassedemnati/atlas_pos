import type { OrderDto, TicketSnapshot, ZData } from '@shared/dto'
import type { Lang } from '@shared/names'
import type { OrderSummaryDto, TicketRowDto, ZHistoryDto } from '@shared/ipc/till'
import type { Result } from '@shared/result'
import type { Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { createCustomersRepo } from '../../../infrastructure/db/repos/customers-repo'
import { createDaysRepo } from '../../../infrastructure/db/repos/days-repo'
import { createOrdersRepo } from '../../../infrastructure/db/repos/orders-repo'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import type { PrintSpooler } from '../../ports'
import { loadOrder, reread, salesContext, toOrderDto, type SalesDeps } from '../orders/context'
import { saleSnapshot } from '../tickets/snapshot'
import { attemptSync, invalidInput } from '../users/outcome'

export interface TillDeps {
  db: Database
  uow: UnitOfWork
  settings: SettingsRepo
  spooler: PrintSpooler
}

export interface TillService {
  listOrders(session: Session): Result<OrderSummaryDto[]>
  printPrebill(session: Session, orderId: string): Result<OrderDto>
  listTickets(session: Session, input: { dayId?: string | undefined; q?: string | undefined }): Result<TicketRowDto[]>
  zHistory(session: Session): Result<ZHistoryDto[]>
  reprintZ(session: Session, zId: string): Result<true>
  setLang(session: Session, lang: Lang): Result<true>
}

interface TicketDbRow {
  id: string
  kind: 'sale' | 'credit'
  number: number
  label: string
  closed_at: string
  total_cents: number
  snapshot_json: string
  reprint_count: number
}

export function createTillService(deps: TillDeps & Pick<SalesDeps, 'clock' | 'overrides'>): TillService {
  const { db, uow, settings, spooler } = deps
  const sales = salesContext({ ...deps })

  function listOrders(): OrderSummaryDto[] {
    const requested = new Set(
      db.prepare("SELECT id FROM orders WHERE status IN ('open', 'parked') AND bill_requested_at IS NOT NULL").pluck().all() as string[]
    )
    return createOrdersRepo(db)
      .listUnfinished()
      .map((order) => {
        const dto = toOrderDto(order)
        return {
          id: dto.id,
          type: dto.type,
          status: dto.status as 'open' | 'parked',
          tableId: dto.tableId,
          tableLabel: dto.tableLabel,
          covers: dto.covers,
          orderNumber: dto.orderNumber,
          openedAt: dto.openedAt,
          userId: dto.userId,
          totalCents: dto.totals.totalCents,
          paidCents: dto.paidCents,
          linesCount: dto.lines.filter((l) => l.status === 'active').length,
          billRequested: requested.has(dto.id)
        }
      })
  }

  function printPrebill(session: Session, orderId: string): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(sales, orderId)
      if (!order.lines.some((l) => l.status === 'active')) throw new AppErrorException('order_empty')
      const day = createDaysRepo(db).get(order.dayId)
      const table = order.tableId ? sales.orders.table(order.tableId) : undefined
      const customer = order.customerId ? createCustomersRepo(db).get(order.customerId) : undefined
      const snapshot = {
        ...saleSnapshot({
          number: 0,
          label: '',
          closedAt: tx.clock.now().toISOString(),
          dayNumber: day?.number ?? 0,
          business: settings.get('business.legal'),
          receipt: { lang: settings.get('receipt.lang'), header: settings.get('receipt.header'), footer: '' },
          user: { id: session.userId, displayName: session.displayName },
          order,
          table: table ? { id: table.id, label: table.label } : null,
          customer,
          categoryOf: () => undefined,
          methodName: (code) => ({ fr: code })
        }),
        payments: [],
        paidCents: 0,
        changeCents: 0
      }
      spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'prebill', payload: { snapshot } })
      db.prepare('UPDATE orders SET bill_requested_at = ? WHERE id = ?').run(tx.clock.now().toISOString(), order.id)
      appendEvent(tx.db, { type: 'order.prebill', entity: 'order', entityId: order.id, userId: session.userId }, tx.clock)
      tx.events.push({ type: 'order.changed', orderId: order.id })
      return reread(sales, order.id)
    })
  }

  function listTickets(input: { dayId?: string | undefined; q?: string | undefined }): TicketRowDto[] {
    const q = input.q?.trim() ?? ''
    let rows: TicketDbRow[]
    if (input.dayId === undefined && q !== '') {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      rows = db
        .prepare("SELECT * FROM tickets WHERE label LIKE ? ESCAPE '\\' ORDER BY closed_at DESC, rowid DESC LIMIT 200")
        .all(like) as TicketDbRow[]
    } else {
      const dayId =
        input.dayId ??
        createDaysRepo(db).openDay()?.id ??
        (db.prepare('SELECT id FROM business_days ORDER BY number DESC LIMIT 1').pluck().get() as string | undefined)
      if (dayId === undefined) return []
      rows = db.prepare('SELECT * FROM tickets WHERE day_id = ? ORDER BY closed_at DESC, rowid DESC LIMIT 500').all(dayId) as TicketDbRow[]
      if (q !== '') rows = rows.filter((r) => r.label.includes(q))
    }
    const cancelled = new Set(
      db.prepare("SELECT ref_ticket_id FROM tickets WHERE kind = 'credit' AND ref_ticket_id IS NOT NULL").pluck().all() as string[]
    )
    return rows.map((row) => {
      const snapshot = JSON.parse(row.snapshot_json) as TicketSnapshot
      return {
        id: row.id,
        kind: row.kind,
        number: row.number,
        label: row.label,
        closedAt: row.closed_at,
        userName: snapshot.user.displayName,
        totalCents: row.total_cents,
        orderType: snapshot.order.type,
        orderNumber: snapshot.order.number,
        tableLabel: snapshot.order.table?.label ?? null,
        cancelled: row.kind === 'sale' && cancelled.has(row.id),
        refLabel: snapshot.ref?.label ?? null,
        reprintCount: row.reprint_count
      }
    })
  }

  function zHistory(): ZHistoryDto[] {
    const rows = db
      .prepare(
        `SELECT z.id, z.day_id, z.number, z.data_json, d.number AS day_number, d.closed_at
           FROM z_reports z JOIN business_days d ON d.id = z.day_id ORDER BY z.number DESC LIMIT 200`
      )
      .all() as { id: string; day_id: string; number: number; data_json: string; day_number: number; closed_at: string | null }[]
    return rows.map((row) => {
      const data = JSON.parse(row.data_json) as ZData
      return {
        zId: row.id,
        dayId: row.day_id,
        zNumber: row.number,
        dayNumber: row.day_number,
        closedAt: row.closed_at ?? data.closedAt ?? '',
        ticketsCount: data.ticketsCount,
        totalCents: data.totalCents
      }
    })
  }

  function reprintZ(session: Session, zId: string): true {
    uow.run((tx) => {
      const exists = db.prepare('SELECT 1 FROM z_reports WHERE id = ?').get(zId)
      if (!exists) throw invalidInput('zId', 'unknown Z report')
      spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'z', payload: { zId } })
      appendEvent(tx.db, { type: 'z.reprinted', entity: 'z', entityId: zId, userId: session.userId }, tx.clock)
    })
    return true
  }

  function setLang(session: Session, lang: Lang): true {
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, session.userId)
    return true
  }

  return {
    listOrders: () => attemptSync(listOrders),
    printPrebill: (session, orderId) => attemptSync(() => printPrebill(session, orderId)),
    listTickets: (_session, input) => attemptSync(() => listTickets(input)),
    zHistory: () => attemptSync(zHistory),
    reprintZ: (session, zId) => attemptSync(() => reprintZ(session, zId)),
    setLang: (session, lang) => attemptSync(() => setLang(session, lang))
  }
}
