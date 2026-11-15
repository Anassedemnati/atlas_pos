import type { DayDto, DayGateDto, ZData } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { activeLines } from '../../../domain/order/order'
import { hasPermission, requirePermission, type OverrideToken, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { nextSequence } from '../../../infrastructure/db/sequences'
import { AppErrorException } from '../../errors'
import { logOrder, toOrderDto, type Sales } from '../orders/context'
import { attemptSync, invalidInput } from '../users/outcome'
import { gateOf } from './day'
import { computeZData } from './z-data'

export interface DayUseCases {
  /** The open business day, or null between a Z and the next sale (no day is opened here). */
  currentDay(session: Session): Result<DayDto | null>
  /** Whether the till may sell, or must first close the previous day (see `gateOf`). */
  dayGate(session: Session): Result<DayGateDto>
  /**
   * Needs `report.x`. The figures of the open day so far (`no_open_day` when none), or of `dayId`: a
   * closed day gives its stored Z.
   */
  xReport(session: Session, dayId?: string): Result<ZData>
  /**
   * The Z: needs `day.close`, or a manager's `overrideToken` for it (`forbidden` otherwise; spent once the checks have
   * passed, recorded as `overriddenBy`). Refused with `open_orders_exist` (`params.orders`) while an order with
   * lines or payments is open or parked; empty ones are cancelled with the Z. In one transaction: the
   * next Z number, the immutable `z_reports` row, the day closed, the Z queued for printing. Announces
   * `day.closed`, then asks for a full backup (setting `backup.onClose`). The next sale opens a new day.
   */
  closeDay(session: Session, overrideToken?: OverrideToken): Result<{ zId: string; data: ZData }>
}

export function createDayUseCases(ctx: Sales): DayUseCases {
  const { uow, settings } = ctx

  const figures = (day: DayDto, zNumber: number | null, closedAt: string | null): ZData =>
    computeZData({
      day,
      zNumber,
      closedAt,
      tickets: ctx.tickets.listOfDay(day.id),
      voids: ctx.orders.voidLinesOfDay(day.id),
      reprints: ctx.days.countDayEvents('ticket.reprinted', day.id)
    })

  function x(session: Session, dayId?: string): ZData {
    requirePermission(session, 'report.x')
    const day = dayId === undefined ? ctx.days.openDay() : ctx.days.get(dayId)
    if (!day) {
      if (dayId === undefined) throw new AppErrorException('no_open_day')
      throw invalidInput('dayId', 'unknown day')
    }
    if (day.closedAt !== null) {
      const z = ctx.days.getZ(day.id)
      if (z) return z.data
    }
    return figures(day, null, null)
  }

  function close(session: Session, token?: OverrideToken): { zId: string; data: ZData } {
    const held = hasPermission(session, 'day.close')
    if (!held) {
      if (token === undefined) throw new AppErrorException('forbidden', { permission: 'day.close' })
      if (!ctx.overrides.isOverrideValid(token, 'day.close')) {
        throw new AppErrorException('forbidden', { permission: 'day.close', reason: 'override_invalid' })
      }
    }
    const result = uow.run((tx) => {
      const day = ctx.days.openDay()
      if (!day) throw new AppErrorException('no_open_day')
      const unfinished = ctx.orders.listUnfinished()
      const empty = unfinished.filter((o) => activeLines(o.lines).length === 0 && o.payments.length === 0)
      const blocking = unfinished.filter((o) => !empty.includes(o))
      if (blocking.length > 0) {
        throw new AppErrorException('open_orders_exist', {
          orders: blocking.map((o) => ({
            id: o.id,
            type: o.type,
            status: o.status,
            tableLabel: o.tableLabel,
            orderNumber: o.orderNumber,
            totalCents: toOrderDto(o).totals.totalCents
          }))
        })
      }
      // Every check has passed: a manager's approval is spent now (a blocked Z does not burn it).
      let approvedBy: string | undefined
      if (!held && token !== undefined) {
        const used = ctx.overrides.consumeOverride(token, 'day.close')
        if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
        approvedBy = used.value.byUserId
      }
      for (const order of empty) logOrder(tx, ctx, session, { ...order, status: 'cancelled' }, 'order.cancelled_at_z', { dayId: day.id })

      const zNumber = nextSequence(tx.db, 'z')
      const closedAt = tx.clock.now().toISOString()
      const data = figures(day, zNumber, closedAt)
      const zId = newId()
      ctx.days.insertZ(tx, { id: zId, dayId: day.id, number: zNumber, data, createdAt: closedAt, userId: session.userId })
      ctx.days.close(tx, day.id, closedAt)
      appendEvent(
        tx.db,
        { type: 'day.closed', entity: 'day', entityId: day.id, userId: session.userId, data: { zId, zNumber, totalCents: data.totalCents, ...(approvedBy ? { overriddenBy: approvedBy } : {}) } },
        tx.clock
      )
      ctx.spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'z', payload: { zId } })
      tx.events.push({ type: 'day.closed', dayId: day.id, zId })
      return { zId, data }
    })
    // Committed: the backup runs on its own and never rejects; the till does not wait for it.
    if (ctx.backup && settings.get('backup.onClose')) void ctx.backup.runFull('full', `Z${result.data.zNumber}`)
    return result
  }

  return {
    currentDay: () => attemptSync(() => ctx.days.openDay() ?? null),
    dayGate: () =>
      attemptSync(() => gateOf(ctx.days.openDay(), ctx.days.lastNumber() + 1, ctx.clock.now(), settings.get('day.cutoverHour'))),
    xReport: (session, dayId) => attemptSync(() => x(session, dayId)),
    closeDay: (session, overrideToken) => attemptSync(() => close(session, overrideToken))
  }
}
