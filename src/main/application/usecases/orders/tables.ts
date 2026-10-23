import type { OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import type { Session } from '../../../domain/users/session'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { assertNotBelowPaid, loadOrder, logOrder, reread, type Sales } from './context'

export interface TableUseCases {
  /** Moves a table's order to a free table (`table_occupied` otherwise). */
  transferTable(session: Session, orderId: string, toTableId: string): Result<OrderDto>
  /**
   * Puts everything of `fromOrderId` (lines, void ones included, payments, covers) on `intoOrderId`; the
   * emptied order is cancelled. Refused with `ticket_discount_set` while the merged order has a ticket
   * discount (remove it first: it was given on that bill, not on the other), and with `below_paid` when
   * the merged bill, under the target's ticket discount, would be less than what both were paid.
   */
  mergeTables(session: Session, fromOrderId: string, intoOrderId: string): Result<OrderDto>
  /**
   * Moves active lines to another open order (they keep their kitchen state). `below_paid` if what stays
   * would be under what the source order was already paid. Returns the source order.
   */
  moveLines(session: Session, fromOrderId: string, lineIds: string[], toOrderId: string): Result<OrderDto>
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

  function merge(session: Session, fromOrderId: string, intoOrderId: string): OrderDto {
    return uow.run((tx) => {
      const [from, into] = pair(fromOrderId, intoOrderId)
      if (from.discount !== null) throw new AppErrorException('ticket_discount_set', { orderId: from.id })
      // The target's ticket discount now applies to more lines (a percentage), or cannot grow (an amount
      // capped at its lines): the merged bill must still cover what both tables already paid.
      assertNotBelowPaid([...into.lines, ...from.lines], into.discount, [...into.payments, ...from.payments])
      moveTo(tx, from.lines, into)
      ctx.orders.movePayments(tx, from.id, into.id)
      const lineIds = from.lines.map((l) => l.id)
      logOrder(tx, ctx, session, { ...from, status: 'cancelled' }, 'order.merged_away', { intoOrderId: into.id, lineIds })
      logOrder(tx, ctx, session, { ...into, covers: into.covers + from.covers }, 'order.merged', {
        fromOrderId: from.id,
        lineIds,
        paymentIds: from.payments.map((p) => p.id)
      })
      return reread(ctx, into.id)
    })
  }

  function move(session: Session, fromOrderId: string, lineIds: string[], toOrderId: string): OrderDto {
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
      assertNotBelowPaid(
        from.lines.filter((l) => !lineIds.includes(l.id)),
        from.discount,
        from.payments
      )
      moveTo(tx, moving, to)
      logOrder(tx, ctx, session, from, 'order.lines_moved_out', { toOrderId: to.id, lineIds })
      logOrder(tx, ctx, session, to, 'order.lines_moved_in', { fromOrderId: from.id, lineIds })
      return reread(ctx, from.id)
    })
  }

  return {
    transferTable: (session, orderId, toTableId) => attemptSync(() => transfer(session, orderId, toTableId)),
    mergeTables: (session, fromOrderId, intoOrderId) => attemptSync(() => merge(session, fromOrderId, intoOrderId)),
    moveLines: (session, fromOrderId, lineIds, toOrderId) => attemptSync(() => move(session, fromOrderId, lineIds, toOrderId))
  }
}
