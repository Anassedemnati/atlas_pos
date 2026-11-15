import type { OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import { activeLines, unsentLines } from '../../../domain/order/order'
import type { Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync } from '../users/outcome'
import { loadOrder, reread, type Sales } from './context'

export interface KitchenUseCases {
  /**
   * Sends the lines the kitchen has not received, up to the current course: on the first send, the lines
   * without a course and the first course ordered; afterwards, any new line of a course already fired.
   * Sets `sent_at`, queues a kitchen ticket and announces `order.sent`. `nothing_to_send` when there is none.
   */
  sendToKitchen(session: Session, orderId: string): Result<OrderDto>
  /** Fires the next course still waiting (with any line of an earlier one not sent yet). */
  sendNextCourse(session: Session, orderId: string): Result<OrderDto>
}

/** The highest course already sent, -1 before the first send. */
const firedCourse = (lines: StoredLine[]): number =>
  lines.filter((l) => l.sentAt !== null).reduce((max, l) => Math.max(max, l.course), -1)

/** The smallest course above `after` still waiting, or undefined. */
const nextWaitingCourse = (lines: StoredLine[], after: number): number | undefined => {
  const waiting = unsentLines(lines)
    .map((l) => l.course)
    .filter((c) => c > after)
  return waiting.length === 0 ? undefined : Math.min(...waiting)
}

/**
 * Marks `lines` sent now, queues their kitchen ticket (routed by category in the print queue) and
 * announces `order.sent`, inside the caller's transaction. Used by the send use cases and by closing.
 */
export function sendLines(tx: Tx, ctx: Sales, session: Session, order: StoredOrder, lines: StoredLine[]): void {
  if (lines.length === 0) return
  const sentAt = tx.clock.now().toISOString()
  for (const line of lines) ctx.orders.updateLine(tx, { ...line, sentAt })
  const lineIds = lines.map((l) => l.id)
  ctx.spooler.enqueue(tx, { target: { role: 'kitchen' }, kind: 'kitchen', payload: { orderId: order.id, lineIds } })
  appendEvent(tx.db, { type: 'order.sent', entity: 'order', entityId: order.id, userId: session.userId, data: { lineIds } }, tx.clock)
  tx.events.push({ type: 'order.sent', orderId: order.id, lineIds })
}

export function createKitchenUseCases(ctx: Sales): KitchenUseCases {
  const send = (session: Session, orderId: string, upto: (lines: StoredLine[]) => number | undefined): OrderDto =>
    ctx.uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const course = upto(order.lines)
      const lines = course === undefined ? [] : unsentLines(order.lines, course)
      if (lines.length === 0) throw new AppErrorException('nothing_to_send')
      sendLines(tx, ctx, session, order, lines)
      ctx.orders.updateHeader(tx, { ...order, updatedAt: tx.clock.now().toISOString() })
      tx.events.push({ type: 'order.changed', orderId: order.id })
      return reread(ctx, order.id)
    })

  return {
    sendToKitchen: (session, orderId) =>
      attemptSync(() =>
        send(session, orderId, (lines) => {
          const fired = firedCourse(lines)
          // A course >= 1 already fired: send up to it. Otherwise the first course waiting (0 if none).
          if (fired >= 1) return fired
          return Math.max(0, nextWaitingCourse(lines, 0) ?? 0)
        })
      ),
    sendNextCourse: (session, orderId) =>
      attemptSync(() =>
        send(session, orderId, (lines) =>
          activeLines(lines).length === 0 ? undefined : nextWaitingCourse(lines, Math.max(0, firedCourse(lines)))
        )
      )
  }
}
