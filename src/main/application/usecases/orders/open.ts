import type { OrderDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import type { Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import { nextSequence, resetSequence } from '../../../infrastructure/db/sequences'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { ensureDay, gateOf, ORDER_NUMBER_MAX, ORDER_NUMBER_SEQUENCE } from '../days/day'
import { attemptSync, invalidInput } from '../users/outcome'
import { activeLine, loadOrder, logOrder, reread, toOrderDto, type Sales } from './context'
import { CoversSchema, IdSchema, NoteSchema, OpenOrderSchema, type OpenOrderInput } from './inputs'

export interface OpenUseCases {
  /**
   * Opens an order, and the business day with it when none is open (the first sale after a Z). A table
   * that already has an open or parked order gives that order back unchanged. A café gives takeaway and
   * counter orders a number (1-999, wrapping, reset each day). Refused with `day_must_close` while the
   * open day has passed its cut-over (the till asks for the Z first); orders already open can still be
   * finished.
   */
  openOrder(session: Session, input: OpenOrderInput): Result<OrderDto>
  getOrder(session: Session, orderId: string): Result<OrderDto>
  /** The order's note, or with `lineId` the note of a line the kitchen has not received yet. */
  setNote(session: Session, orderId: string, note: string, lineId?: string): Result<OrderDto>
  setCovers(session: Session, orderId: string, covers: number): Result<OrderDto>
  /** `null` takes the customer off. */
  assignCustomer(session: Session, orderId: string, customerId: string | null): Result<OrderDto>
  /** Mise en attente: a parked order takes no change until it is resumed. */
  parkOrder(session: Session, orderId: string): Result<OrderDto>
  resumeOrder(session: Session, orderId: string): Result<OrderDto>
}

/** Next café order number, inside the caller's transaction: 999 is followed by 1. */
function nextOrderNumber(tx: Tx): number {
  const n = nextSequence(tx.db, ORDER_NUMBER_SEQUENCE)
  if (n <= ORDER_NUMBER_MAX) return n
  resetSequence(tx.db, ORDER_NUMBER_SEQUENCE, 1)
  return 1
}

export function createOpenUseCases(ctx: Sales): OpenUseCases {
  const { uow, settings } = ctx

  function open(session: Session, raw: OpenOrderInput): OrderDto {
    const input = parseInput(OpenOrderSchema, raw)
    if (input.tableId !== undefined && input.type !== 'dine_in') throw invalidInput('tableId', 'only dine_in orders sit at a table')
    return uow.run((tx) => {
      if (input.tableId !== undefined) {
        const table = ctx.orders.table(input.tableId)
        if (!table || !table.active) throw invalidInput('tableId', 'unknown table')
        const existing = ctx.orders.findOnTable(table.id)
        if (existing) return toOrderDto(loadOrder(ctx, existing, ['open', 'parked']))
      }
      if (input.customerId !== undefined && !ctx.customers.get(input.customerId)) {
        throw invalidInput('customerId', 'unknown customer')
      }
      const now = tx.clock.now()
      const gate = gateOf(ctx.days.openDay(), 0, now, settings.get('day.cutoverHour'))
      if (gate.state === 'must_close') throw new AppErrorException('day_must_close', { dayNumber: gate.dayNumber })
      const day = ensureDay(tx, ctx, session.userId)
      const numbered = settings.get('business.type') === 'cafe' && (input.type === 'takeaway' || input.type === 'counter')
      const order: StoredOrder = {
        id: newId(),
        dayId: day.id,
        type: input.type,
        tableId: input.tableId ?? null,
        tableLabel: null,
        covers: input.covers ?? 0,
        orderNumber: numbered ? nextOrderNumber(tx) : null,
        status: 'open',
        userId: session.userId,
        customerId: input.customerId ?? null,
        openedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        note: '',
        discount: null,
        lines: [],
        payments: []
      }
      ctx.orders.insert(tx, order)
      appendEvent(
        tx.db,
        {
          type: 'order.opened',
          entity: 'order',
          entityId: order.id,
          userId: session.userId,
          data: { type: order.type, tableId: order.tableId, orderNumber: order.orderNumber, dayId: day.id }
        },
        tx.clock
      )
      tx.events.push({ type: 'order.changed', orderId: order.id })
      return reread(ctx, order.id)
    })
  }

  /** One change to the header of an open order, logged as `type`. */
  const change = (
    session: Session,
    orderId: string,
    type: string,
    apply: (order: StoredOrder) => { order: StoredOrder; data: unknown },
    allowed: ('open' | 'parked')[] = ['open']
  ): OrderDto =>
    uow.run((tx) => {
      const { order, data } = apply(loadOrder(ctx, orderId, allowed))
      logOrder(tx, ctx, session, order, type, data)
      return reread(ctx, order.id)
    })

  function setNote(session: Session, orderId: string, rawNote: string, lineId?: string): OrderDto {
    const note = parseInput(NoteSchema, rawNote)
    if (lineId === undefined) return change(session, orderId, 'order.note', (order) => ({ order: { ...order, note }, data: { note } }))
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      if (line.sentAt !== null) throw new AppErrorException('line_sent', { lineId })
      ctx.orders.updateLine(tx, { ...line, note })
      logOrder(tx, ctx, session, order, 'order.note', { lineId, note })
      return reread(ctx, order.id)
    })
  }

  return {
    openOrder: (session, input) => attemptSync(() => open(session, input)),
    getOrder: (_session, orderId) =>
      attemptSync(() => toOrderDto(loadOrder(ctx, parseInput(IdSchema, orderId), ['open', 'parked', 'closed', 'cancelled']))),
    setNote: (session, orderId, note, lineId) => attemptSync(() => setNote(session, orderId, note, lineId)),
    setCovers: (session, orderId, rawCovers) =>
      attemptSync(() => {
        const covers = parseInput(CoversSchema, rawCovers)
        return change(session, orderId, 'order.covers', (order) => ({ order: { ...order, covers }, data: { covers } }))
      }),
    assignCustomer: (session, orderId, customerId) =>
      attemptSync(() =>
        change(session, orderId, 'order.customer', (order) => {
          if (customerId !== null && !ctx.customers.get(customerId)) throw invalidInput('customerId', 'unknown customer')
          return { order: { ...order, customerId }, data: { customerId } }
        })
      ),
    parkOrder: (session, orderId) =>
      attemptSync(() =>
        change(session, orderId, 'order.parked', (order) => ({ order: { ...order, status: 'parked' }, data: undefined }))
      ),
    resumeOrder: (session, orderId) =>
      attemptSync(() =>
        change(
          session,
          orderId,
          'order.resumed',
          (order) => {
            if (order.status !== 'parked') throw new AppErrorException('order_not_parked')
            return { order: { ...order, status: 'open' }, data: undefined }
          },
          ['parked']
        )
      )
  }
}
