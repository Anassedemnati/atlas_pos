import type { DiscountDto, OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import type { Discount } from '../../../domain/order/discount'
import { lineGross } from '../../../domain/order/line'
import { computeTotals } from '../../../domain/order/totals'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync } from '../users/outcome'
import { activeLine, assertNotBelowPaid, loadOrder, logOrder, reread, type Sales } from './context'
import { DiscountSchema, reasonOf } from './inputs'

export interface DiscountUseCases {
  /**
   * Sets (or with `null` removes) the discount of a line. Setting one needs `order.discount`; above the
   * profile's `maxDiscountBp` it also needs `overrideToken`, a manager's approval from `authorizeOverride`
   * for `order.discount.override`, which is spent and logged as `overriddenBy`. A fixed amount is measured
   * as the percentage it takes off the line, rounded up. `below_paid` if the bill would drop under what
   * was already paid (the token is then not spent).
   */
  setLineDiscount(
    session: Session,
    orderId: string,
    lineId: string,
    discount: DiscountDto | null,
    overrideToken?: OverrideToken
  ): Result<OrderDto>
  /** The same for the whole ticket, measured against the lines after their own discounts. */
  setTicketDiscount(session: Session, orderId: string, discount: DiscountDto | null, overrideToken?: OverrideToken): Result<OrderDto>
  /**
   * Offers a line (`free` true, with a reason) or charges it again. Offering needs `order.free_item`, or
   * an override token for it (spent, logged as `overriddenBy`).
   */
  setFree(
    session: Session,
    orderId: string,
    lineId: string,
    free: boolean,
    reason: string,
    overrideToken?: OverrideToken
  ): Result<OrderDto>
}

/** The share of `baseCents` a discount takes, in basis points; an amount is rounded up, so it never slips under a limit. */
function discountBp(discount: Discount, baseCents: number): number {
  if (discount.kind === 'pct') return discount.bp
  if (discount.cents === 0 || baseCents === 0) return 0
  return discount.cents >= baseCents ? 10000 : Math.ceil((discount.cents * 10000) / baseCents)
}

const noOverride = (): { overriddenBy?: string } => ({})

const fromRefusal = (r: Result<unknown>): never => {
  if (r.ok) throw new Error('fromRefusal called with a success')
  throw new AppErrorException(r.error.code, r.error.params)
}

export function createDiscountUseCases(ctx: Sales): DiscountUseCases {
  const { uow, overrides } = ctx

  /**
   * Checks what can be checked without spending the override token, and returns the step that spends it,
   * to run once every other check has passed.
   */
  function authorizeDiscount(session: Session, bp: number, token: OverrideToken | undefined): () => { overriddenBy?: string } {
    if (!hasPermission(session, 'order.discount')) throw new AppErrorException('forbidden', { permission: 'order.discount' })
    if (bp > session.maxDiscountBp && token === undefined) {
      throw new AppErrorException('forbidden', { permission: 'order.discount.override', maxDiscountBp: session.maxDiscountBp })
    }
    return () => {
      const checked = overrides.checkDiscount(session, bp, token)
      return checked.ok ? checked.value : fromRefusal(checked)
    }
  }

  const parseDiscount = (raw: DiscountDto | null): Discount | null => (raw === null ? null : parseInput(DiscountSchema, raw))

  function setLine(session: Session, orderId: string, lineId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      const spend = discount ? authorizeDiscount(session, discountBp(discount, lineGross(line)), token) : noOverride
      const updated = { ...line, discount }
      assertNotBelowPaid(
        order.lines.map((l) => (l.id === lineId ? updated : l)),
        order.discount,
        order.payments
      )
      const { overriddenBy } = spend()
      ctx.orders.updateLine(tx, updated)
      logOrder(tx, ctx, session, order, 'order.discount', { lineId, discount, ...(overriddenBy ? { overriddenBy } : {}) })
      return reread(ctx, order.id)
    })
  }

  function setTicket(session: Session, orderId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const base = computeTotals(order.lines, null).total
      const spend = discount ? authorizeDiscount(session, discountBp(discount, base), token) : noOverride
      assertNotBelowPaid(order.lines, discount, order.payments)
      const { overriddenBy } = spend()
      logOrder(tx, ctx, session, { ...order, discount }, 'order.discount', {
        discount,
        ...(overriddenBy ? { overriddenBy } : {})
      })
      return reread(ctx, order.id)
    })
  }

  function setFree(
    session: Session,
    orderId: string,
    lineId: string,
    free: boolean,
    rawReason: string,
    token?: OverrideToken
  ): OrderDto {
    const reason = free ? reasonOf(rawReason) : ''
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      const held = !free || hasPermission(session, 'order.free_item')
      if (!held && token === undefined) throw new AppErrorException('forbidden', { permission: 'order.free_item' })
      const updated = { ...line, free, freeReason: reason }
      assertNotBelowPaid(
        order.lines.map((l) => (l.id === lineId ? updated : l)),
        order.discount,
        order.payments
      )
      let overriddenBy: string | undefined
      if (!held && token !== undefined) {
        const used = overrides.consumeOverride(token, 'order.free_item')
        overriddenBy = used.ok ? used.value.byUserId : fromRefusal(used)
      }
      ctx.orders.updateLine(tx, updated)
      logOrder(tx, ctx, session, order, 'order.free', { lineId, free, reason, ...(overriddenBy ? { overriddenBy } : {}) })
      return reread(ctx, order.id)
    })
  }

  return {
    setLineDiscount: (session, orderId, lineId, discount, token) =>
      attemptSync(() => setLine(session, orderId, lineId, discount, token)),
    setTicketDiscount: (session, orderId, discount, token) => attemptSync(() => setTicket(session, orderId, discount, token)),
    setFree: (session, orderId, lineId, free, reason, token) =>
      attemptSync(() => setFree(session, orderId, lineId, free, reason, token))
  }
}
