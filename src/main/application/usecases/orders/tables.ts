import type { OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import type { OverrideToken, Session } from '../../../domain/users/session'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { assertNotBelowPaid, enforceDiscountLimit, loadOrder, logOrder, reread, type DiscountApproval, type Sales } from './context'

export interface TableUseCases {
  /** Moves a table's order to a free table (`table_occupied` otherwise). */
  transferTable(session: Session, orderId: string, toTableId: string): Result<OrderDto>
  /**
   * Puts everything of `fromOrderId` (lines, void ones included, payments, covers) on `intoOrderId`; the
   * emptied order is cancelled. Refused with `ticket_discount_set` while the merged order has a ticket
   * discount (remove it first: it was given on that bill, not on the other), and with `below_paid` when
   * the merged bill, under the target's ticket discount, would be less than what both were paid. The
   * merged order's discount is checked against the session and both orders' approvals
   * (`discount_over_limit` unless `overrideToken`).
   */
  mergeTables(session: Session, fromOrderId: string, intoOrderId: string, overrideToken?: OverrideToken): Result<OrderDto>
  /**
   * Moves active lines to another open order (they keep their kitchen state). `below_paid` if what stays
   * would be under what the source order was already paid. Both orders' discounts are checked again
   * (`discount_over_limit` unless `overrideToken`, spent once for both). Returns the source order.
   */
  moveLines(session: Session, fromOrderId: string, lineIds: string[], toOrderId: string, overrideToken?: OverrideToken): Result<OrderDto>
}

export function createTableUseCases(ctx: Sales): TableUseCases {
  const { uow } = ctx

  /** Two different open orders. */
  const pair = (fromId: string, toId: string): [StoredOrder, StoredOrder] => {
    const from = loadOrder(ctx, fromId)
    const to = loadOrder(ctx, toId)
    if (from.id === to.id) throw invalidInput('toOrderId', 'same order')
    return [from, to]
  }

  /** Appends `lines` to `to`, after its own lines. */
  const moveTo = (tx: Tx, lines: StoredLine[], to: StoredOrder): void => {
    let seq = ctx.orders.nextSeq(to.id)
    for (const line of lines) ctx.orders.moveLine(tx, line.id, to.id, seq++)
  }

  function transfer(session: Session, orderId: string, toTableId: string): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId, ['open', 'parked'])
      if (order.type !== 'dine_in') throw invalidInput('orderId', 'not a table order')
      const table = typeof toTableId === 'string' ? ctx.orders.table(toTableId) : undefined
      if (!table || !table.active) throw invalidInput('toTableId', 'unknown table')
      const occupant = ctx.orders.findOnTable(table.id)
      if (occupant !== undefined && occupant !== order.id) throw new AppErrorException('table_occupied', { tableId: table.id })
      logOrder(tx, ctx, session, { ...order, tableId: table.id }, 'order.transferred', { from: order.tableId, to: table.id })
      return reread(ctx, order.id)
    })
  }

  /** The approval of `order` once its lines are `lines`, spending `approval` if a check needs it. */
  const recheck = (session: Session, order: StoredOrder, lines: StoredLine[], approvedBp: number | null, approval: DiscountApproval) =>
    enforceDiscountLimit(ctx, session, { lines, discount: order.discount, approvedBp }, approval)
  const audit = (approval: DiscountApproval) => (approval.usedBy ? { overriddenBy: approval.usedBy } : {})
  const maxApproval = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

  function merge(session: Session, fromOrderId: string, intoOrderId: string, token?: OverrideToken): OrderDto {
    return uow.run((tx) => {
      const [from, into] = pair(fromOrderId, intoOrderId)
      if (from.discount !== null) throw new AppErrorException('ticket_discount_set', { orderId: from.id })
      // The target's ticket discount now applies to more lines (a percentage), or cannot grow (an amount
      // capped at its lines): the merged bill must still cover what both tables already paid.
      const mergedLines = [...into.lines, ...from.lines]
      assertNotBelowPaid(mergedLines, into.discount, [...into.payments, ...from.payments])
      const approval: DiscountApproval = { token }
      const approvedBp = recheck(session, into, mergedLines, maxApproval(into.discountApprovedBp, from.discountApprovedBp), approval)
      moveTo(tx, from.lines, into)
      ctx.orders.movePayments(tx, from.id, into.id)
      const lineIds = from.lines.map((l) => l.id)
      logOrder(tx, ctx, session, { ...from, status: 'cancelled' }, 'order.merged_away', { intoOrderId: into.id, lineIds })
      logOrder(tx, ctx, session, { ...into, covers: into.covers + from.covers, discountApprovedBp: approvedBp }, 'order.merged', {
        fromOrderId: from.id,
        lineIds,
        paymentIds: from.payments.map((p) => p.id),
        ...audit(approval)
      })
      return reread(ctx, into.id)
    })
  }

  function move(session: Session, fromOrderId: string, lineIds: string[], toOrderId: string, token?: OverrideToken): OrderDto {
    return uow.run((tx) => {
      const [from, to] = pair(fromOrderId, toOrderId)
      if (!Array.isArray(lineIds) || lineIds.length === 0 || new Set(lineIds).size !== lineIds.length) {
        throw invalidInput('lineIds', 'one or more distinct lines')
      }
      const moving = lineIds.map((id) => {
        const line = from.lines.find((l) => l.id === id && l.status === 'active')
        if (!line) throw invalidInput('lineIds', 'unknown line')
        return line
      })
      const staying = from.lines.filter((l) => !lineIds.includes(l.id))
      assertNotBelowPaid(staying, from.discount, from.payments)
      const approval: DiscountApproval = { token }
      const fromApproved = recheck(session, from, staying, from.discountApprovedBp, approval)
      // The lines carry their own discounts, approved on the source order.
      const toApproved = recheck(session, to, [...to.lines, ...moving], maxApproval(to.discountApprovedBp, from.discountApprovedBp), approval)
      moveTo(tx, moving, to)
      logOrder(tx, ctx, session, { ...from, discountApprovedBp: fromApproved }, 'order.lines_moved_out', {
        toOrderId: to.id,
        lineIds,
        ...audit(approval)
      })
      logOrder(tx, ctx, session, { ...to, discountApprovedBp: toApproved }, 'order.lines_moved_in', { fromOrderId: from.id, lineIds })
      return reread(ctx, from.id)
    })
  }

  return {
    transferTable: (session, orderId, toTableId) => attemptSync(() => transfer(session, orderId, toTableId)),
    mergeTables: (session, fromOrderId, intoOrderId, token) => attemptSync(() => merge(session, fromOrderId, intoOrderId, token)),
    moveLines: (session, fromOrderId, lineIds, toOrderId, token) =>
      attemptSync(() => move(session, fromOrderId, lineIds, toOrderId, token))
  }
}
