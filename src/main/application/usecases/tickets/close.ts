import type { TicketDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { activeLines, CASH_METHOD_CODE, unsentLines } from '../../../domain/order/order'
import { splitByItems } from '../../../domain/order/split'
import { computeTotals, priceLines } from '../../../domain/order/totals'
import type { Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import { nextSequence } from '../../../infrastructure/db/sequences'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { loadOrder, logOrder, paymentTotals, type Sales } from '../orders/context'
import { SplitGroupsSchema, type AddPaymentInput } from '../orders/inputs'
import { sendLines } from '../orders/kitchen'
import { applyPayment } from '../orders/payments'
import { attemptSync } from '../users/outcome'
import { saleSnapshot, ticketLabel, type SnapshotHeader } from './snapshot'

export interface SplitGroup {
  /** Active lines of the order. */
  lineIds: string[]
  /** What pays this part; it must pay it in full. */
  payments: AddPaymentInput[]
}

export interface CloseUseCases {
  /**
   * Closes a paid order (`not_paid` with `params.dueCents` otherwise, `order_empty` with no active line).
   * In one transaction: whatever the kitchen has not received is sent, the next ticket number is taken
   * (gap-free), the immutable ticket is written with its full snapshot, the order is closed, and the
   * receipt (and, for cash, a drawer pulse) is queued. Announces `ticket.closed`.
   */
  closeOrder(session: Session, orderId: string): Result<TicketDto>
  /**
   * Bill by items: each group becomes its own order, takes its payments and is closed, all in one
   * transaction (a group not paid in full closes none). The ticket discount is shared once over the
   * whole bill. Lines in no group stay on the order with what is left of the ticket discount (as an
   * amount); an order left without an active line is cancelled. Refused with `has_payments` once the
   * order has taken a payment.
   */
  splitAndClose(session: Session, orderId: string, groups: SplitGroup[]): Result<TicketDto[]>
}

/** The header every ticket of this transaction shares: business identity, receipt texts, issuer, day. */
export function ticketHeader(tx: Tx, ctx: Sales, session: Session, kind: 'sale' | 'credit', dayId: string): SnapshotHeader {
  const day = ctx.days.get(dayId)
  if (!day) throw new Error(`business day ${dayId} not found`)
  const number = nextSequence(tx.db, kind === 'sale' ? 'ticket' : 'credit')
  return {
    number,
    label: ticketLabel(kind, number),
    closedAt: tx.clock.now().toISOString(),
    dayNumber: day.number,
    business: ctx.settings.get('business.legal'),
    receipt: {
      lang: ctx.settings.get('receipt.lang'),
      header: ctx.settings.get('receipt.header'),
      footer: ctx.settings.get('receipt.footer')
    },
    user: { id: session.userId, displayName: session.displayName }
  }
}

/** Queues the receipt, and a drawer pulse when cash (or a method that opens the drawer) changed hands. */
export function queueReceipt(tx: Tx, ctx: Sales, ticketId: string, methodCodes: string[]): void {
  ctx.spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'receipt', payload: { ticketId } })
  const opens = methodCodes.some((code) => code === CASH_METHOD_CODE || ctx.orders.paymentMethod(code)?.opensDrawer)
  if (opens) ctx.spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'drawer', payload: { ticketId } })
}

/** Closes `order` inside the caller's transaction. */
export function closeInTx(tx: Tx, ctx: Sales, session: Session, order: StoredOrder): TicketDto {
  if (order.status !== 'open') throw new AppErrorException('order_not_open', { status: order.status })
  if (activeLines(order.lines).length === 0) throw new AppErrorException('order_empty')
  const { due } = paymentTotals(computeTotals(order.lines, order.discount).total, order.payments)
  if (due > 0) throw new AppErrorException('not_paid', { dueCents: due })
  sendLines(tx, ctx, session, order, unsentLines(order.lines))

  const header = ticketHeader(tx, ctx, session, 'sale', order.dayId)
  const table = order.tableId === null ? undefined : ctx.orders.table(order.tableId)
  const snapshot = saleSnapshot({
    ...header,
    order,
    table: table ? { id: table.id, label: table.label } : null,
    customer: order.customerId === null ? undefined : ctx.customers.get(order.customerId),
    categoryOf: (productId) => {
      const product = ctx.catalog.getProduct(productId)
      const category = product && ctx.catalog.getCategory(product.categoryId)
      return category ? { id: category.id, name: category.name } : undefined
    },
    methodName: (code) => ctx.orders.paymentMethod(code)?.name ?? { fr: code }
  })
  const ticket: TicketDto = {
    id: newId(),
    kind: 'sale',
    number: header.number,
    label: header.label,
    orderId: order.id,
    dayId: order.dayId,
    refTicketId: null,
    closedAt: header.closedAt,
    userId: session.userId,
    totalCents: snapshot.totals.totalCents,
    reprintCount: 0,
    snapshot
  }
  ctx.tickets.insert(tx, ticket)
  logOrder(tx, ctx, session, { ...order, status: 'closed' }, 'ticket.closed', {
    ticketId: ticket.id,
    label: ticket.label,
    totalCents: ticket.totalCents
  })
  queueReceipt(
    tx,
    ctx,
    ticket.id,
    order.payments.map((p) => p.methodCode)
  )
  tx.events.push({ type: 'ticket.closed', ticketId: ticket.id })
  return ticket
}

export function createCloseUseCases(ctx: Sales): CloseUseCases {
  const { uow } = ctx

  function split(session: Session, orderId: string, groups: SplitGroup[]): TicketDto[] {
    parseInput(SplitGroupsSchema, groups)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      if (order.payments.length > 0) throw new AppErrorException('has_payments')
      const parts = splitByItems(
        order.lines,
        groups.map((g) => g.lineIds),
        order.discount
      )
      const shares = new Map(priceLines(order.lines, order.discount).map((p) => [p.lineId, p.ticketDiscount]))
      const asAmount = (cents: number) => (order.discount ? { kind: 'amount' as const, cents, reason: order.discount.reason } : null)
      const now = tx.clock.now().toISOString()

      const tickets = groups.map((group, i) => {
        const part = parts[i]!
        const childId = newId()
        ctx.orders.insert(tx, { ...order, id: childId, covers: 0, note: '', openedAt: now, updatedAt: now, discount: asAmount(part.ticketDiscount) })
        group.lineIds.forEach((lineId, k) => ctx.orders.moveLine(tx, lineId, childId, k + 1))
        appendEvent(
          tx.db,
          { type: 'order.split_part', entity: 'order', entityId: childId, userId: session.userId, data: { fromOrderId: order.id } },
          tx.clock
        )
        let child = loadOrder(ctx, childId)
        if (computeTotals(child.lines, child.discount).total !== part.total) throw new Error('split part does not add up')
        for (const payment of group.payments) {
          applyPayment(tx, ctx, session, child, payment)
          child = loadOrder(ctx, childId)
        }
        return closeInTx(tx, ctx, session, child)
      })

      const moved = new Set(groups.flatMap((g) => g.lineIds))
      const left = activeLines(order.lines.filter((l) => !moved.has(l.id)))
      const leftShare = left.reduce((sum, l) => sum + (shares.get(l.id) ?? 0), 0)
      logOrder(
        tx,
        ctx,
        session,
        { ...order, discount: asAmount(leftShare), status: left.length === 0 ? 'cancelled' : 'open' },
        'order.split',
        { ticketIds: tickets.map((t) => t.id), orderIds: tickets.map((t) => t.orderId) }
      )
      return tickets
    })
  }

  return {
    closeOrder: (session, orderId) => attemptSync(() => uow.run((tx) => closeInTx(tx, ctx, session, loadOrder(ctx, orderId)))),
    splitAndClose: (session, orderId, groups) => attemptSync(() => split(session, orderId, groups))
  }
}
