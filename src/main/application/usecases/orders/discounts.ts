import type { DiscountDto, OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import type { Discount } from '../../../domain/order/discount'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync } from '../users/outcome'
import {
  activeLine,
  assertNotBelowPaid,
  enforceDiscountLimit,
  loadOrder,
  logOrder,
  reread,
  type DiscountApproval,
  type Sales
} from './context'
import { DiscountSchema, reasonOf } from './inputs'

export interface DiscountUseCases {
  /**
   * Sets (or with `null` removes) the discount of a line. Setting one needs `order.discount`. The order's
   * combined discount (line and ticket discounts over the gross of the lines that are not free, fixed
   * amounts at their full value) must stay within `max(the profile's maxDiscountBp, what a manager
   * approved for the order)`, else `discount_over_limit` (`params.effectiveBp`, `params.limitBp`), unless
   * `overrideToken` (a manager's `order.discount.override` from `authorizeOverride`) is given: it is then
   * spent, logged as `overriddenBy`, and the approval stored on the order. `below_paid` if the bill would
   * drop under what was already paid (the token is then not spent).
   */
  setLineDiscount(
    session: Session,
    orderId: string,
    lineId: string,
    discount: DiscountDto | null,
    overrideToken?: OverrideToken
  ): Result<OrderDto>
  /** The same for the whole ticket. */
  setTicketDiscount(session: Session, orderId: string, discount: DiscountDto | null, overrideToken?: OverrideToken): Result<OrderDto>
  /**
   * Offers a line (`free` true, with a reason) or charges it again. Offering needs `order.free_item`, or
   * `overrideToken` for it (spent, logged as `overriddenBy`). Offering a line shrinks what the other
   * discounts are measured on, so the combined discount is checked again (`discount_over_limit`, or
   * `discountOverrideToken`).
   */
  setFree(
    session: Session,
    orderId: string,
    lineId: string,
    free: boolean,
    reason: string,
    overrideToken?: OverrideToken,
    discountOverrideToken?: OverrideToken
  ): Result<OrderDto>
}

export function createDiscountUseCases(ctx: Sales): DiscountUseCases {
  const { uow, overrides } = ctx

  const parseDiscount = (raw: DiscountDto | null): Discount | null => (raw === null ? null : parseInput(DiscountSchema, raw))

  /** Checks and writes the order once `lines` / `discount` are what they will be; returns the audit data. */
  function apply(
    tx: Tx,
    session: Session,
    order: StoredOrder,
    after: { lines: StoredLine[]; discount: Discount | null; changed?: StoredLine },
    token: OverrideToken | undefined,
    grant: boolean
  ): { overriddenBy?: string } {
    assertNotBelowPaid(after.lines, after.discount, order.payments)
    const approval: DiscountApproval = { token }
    const approvedBp = enforceDiscountLimit(
      ctx,
      session,
      { lines: after.lines, discount: after.discount, approvedBp: order.discountApprovedBp },
      approval,
      grant
    )
    if (after.changed) ctx.orders.updateLine(tx, after.changed)
    order.discount = after.discount
    order.discountApprovedBp = approvedBp
    return approval.usedBy ? { overriddenBy: approval.usedBy } : {}
  }

  const replaced = (order: StoredOrder, line: StoredLine): StoredLine[] => order.lines.map((l) => (l.id === line.id ? line : l))

  const requireDiscountPermission = (session: Session): void => {
    if (!hasPermission(session, 'order.discount')) throw new AppErrorException('forbidden', { permission: 'order.discount' })
  }

  function setLine(session: Session, orderId: string, lineId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    if (discount) requireDiscountPermission(session)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const changed = { ...activeLine(order, lineId), discount }
      const audit = apply(tx, session, order, { lines: replaced(order, changed), discount: order.discount, changed }, token, discount !== null)
      logOrder(tx, ctx, session, order, 'order.discount', { lineId, discount, ...audit })
      return reread(ctx, order.id)
    })
  }

  function setTicket(session: Session, orderId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    if (discount) requireDiscountPermission(session)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const audit = apply(tx, session, order, { lines: order.lines, discount }, token, discount !== null)
      logOrder(tx, ctx, session, order, 'order.discount', { discount, ...audit })
      return reread(ctx, order.id)
    })
  }

  function setFree(
    session: Session,
    orderId: string,
    lineId: string,
    free: boolean,
    rawReason: string,
    token?: OverrideToken,
    discountToken?: OverrideToken
  ): OrderDto {
    const reason = free ? reasonOf(rawReason) : ''
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const held = !free || hasPermission(session, 'order.free_item')
      if (!held && token === undefined) throw new AppErrorException('forbidden', { permission: 'order.free_item' })
      const changed = { ...activeLine(order, lineId), free, freeReason: reason }
      const audit = apply(tx, session, order, { lines: replaced(order, changed), discount: order.discount, changed }, discountToken, false)
      let freeBy: string | undefined
      if (!held && token !== undefined) {
        const used = overrides.consumeOverride(token, 'order.free_item')
        if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
        freeBy = used.value.byUserId
      }
      logOrder(tx, ctx, session, order, 'order.free', {
        lineId,
        free,
        reason,
        ...(freeBy ? { overriddenBy: freeBy } : {}),
        ...(audit.overriddenBy ? { discountOverriddenBy: audit.overriddenBy } : {})
      })
      return reread(ctx, order.id)
    })
  }

  return {
    setLineDiscount: (session, orderId, lineId, discount, token) =>
      attemptSync(() => setLine(session, orderId, lineId, discount, token)),
    setTicketDiscount: (session, orderId, discount, token) => attemptSync(() => setTicket(session, orderId, discount, token)),
    setFree: (session, orderId, lineId, free, reason, token, discountToken) =>
      attemptSync(() => setFree(session, orderId, lineId, free, reason, token, discountToken))
  }
}
