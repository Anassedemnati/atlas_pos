import type { DiscountDto, OrderDto } from '@shared/dto'
import type { Result } from '@shared/result'
import type { Discount } from '../../../domain/order/discount'
import { lineGross, lineNet } from '../../../domain/order/line'
import { activeLines } from '../../../domain/order/order'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync } from '../users/outcome'
import {
  activeLine,
  applyApprovals,
  approvalsAfterApprovedDiscount,
  approvalsAfterOwnDiscount,
  approvalsOf,
  assertNotBelowPaid,
  assertDiscountApprovable,
  checkDiscountLimit,
  discountGate,
  isLimited,
  loadOrder,
  logOrder,
  reread,
  settleDiscount,
  type DiscountGate,
  type Sales
} from './context'
import { DiscountSchema, reasonOf } from './inputs'

export interface DiscountUseCases {
  /**
   * Sets (or with `null` removes) the discount of a line. Setting one needs `order.discount`. The money
   * the order's discounts take off (line and ticket discounts, on the lines that are not free) must stay
   * within the order's allowance for the session: the staff percentage in force (the profile's
   * `maxDiscountBp`, or the `ownGrantBp` staff already used on the order) of the gross, plus a rounding
   * centime per discounted line, plus what a manager approved for the order (a ticket percentage of the
   * gross and a budget in centimes), all added up; else `discount_over_limit` (`params.discountCents`,
   * `params.limitCents`), unless `overrideToken` (a manager's `order.discount.override` from
   * `authorizeOverride`) is given: it is then spent and logged as `overriddenBy`, and the order records
   * the part of the state the manager approved beyond its allowance. An amount larger than what it
   * applies to is `invalid_discount`. `below_paid` if the bill would drop under what was already paid
   * (the token is then not spent).
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
   * discounts are measured on, so the order's discount is checked again (`discount_over_limit`, or
   * `discountOverrideToken`, whose pass adds to the order's budget what the offered state takes off
   * beyond its allowance).
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

  /** An amount discount cannot take off more than there is (`invalid_discount`, `params.baseCents`). */
  const assertAmountWithinBase = (discount: Discount | null, baseCents: number): void => {
    if (discount?.kind === 'amount' && discount.cents > baseCents) {
      throw new AppErrorException('invalid_discount', { kind: 'amount', value: discount.cents, baseCents })
    }
  }

  const replaced = (order: StoredOrder, line: StoredLine): StoredLine[] => order.lines.map((l) => (l.id === line.id ? line : l))

  const requireDiscountPermission = (session: Session): void => {
    if (!hasPermission(session, 'order.discount')) throw new AppErrorException('forbidden', { permission: 'order.discount' })
  }

  /**
   * Checks the order once `lines` / `discount` are what they will be: under the grants it will carry
   * without a manager (a limited session cannot leave the order in a state it could not close), and if
   * over, as a manager's pass (the gate's token, spent last, or an unlimited session), which then
   * records what it approved beyond the allowance. Writes the changed line and the grants on `order`.
   */
  function applyDiscountChange(
    tx: Tx,
    session: Session,
    order: StoredOrder,
    after: { lines: StoredLine[]; discount: Discount | null; changed?: StoredLine },
    change: 'ticket' | 'line',
    gate: DiscountGate
  ): void {
    assertNotBelowPaid(after.lines, after.discount, order.payments)
    const own = approvalsAfterOwnDiscount(approvalsOf(order), session, after, change)
    const { over } = checkDiscountLimit(session, gate, after, own)
    const viaManager = over || !isLimited(session)
    const approvals = viaManager ? approvalsAfterApprovedDiscount(approvalsOf(order), session, after, change) : own
    if (after.changed) ctx.orders.updateLine(tx, after.changed)
    order.discount = after.discount
    applyApprovals(order, approvals)
  }

  function setLine(session: Session, orderId: string, lineId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    if (discount) requireDiscountPermission(session)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      assertAmountWithinBase(discount, line.free ? 0 : lineGross(line))
      const changed = { ...line, discount }
      const gate = discountGate(token)
      applyDiscountChange(tx, session, order, { lines: replaced(order, changed), discount: order.discount, changed }, 'line', gate)
      const audit = settleDiscount(ctx, gate)
      logOrder(tx, ctx, session, order, 'order.discount', { lineId, discount, ...audit })
      return reread(ctx, order.id)
    })
  }

  function setTicket(session: Session, orderId: string, raw: DiscountDto | null, token?: OverrideToken): OrderDto {
    const discount = parseDiscount(raw)
    if (discount) requireDiscountPermission(session)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      // What a ticket discount applies to: the nets left by the line discounts (free lines at 0).
      assertAmountWithinBase(
        discount,
        activeLines(order.lines).reduce((sum, l) => sum + lineNet(l), 0)
      )
      const gate = discountGate(token)
      applyDiscountChange(tx, session, order, { lines: order.lines, discount }, 'ticket', gate)
      const audit = settleDiscount(ctx, gate)
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
      const lines = replaced(order, changed)
      assertNotBelowPaid(lines, order.discount, order.payments)
      // A base change: checked against the grants the order has; offering a line shrinks the base.
      const gate = discountGate(discountToken)
      applyApprovals(order, checkDiscountLimit(session, gate, { lines, discount: order.discount }, approvalsOf(order), free).approvals)
      ctx.orders.updateLine(tx, changed)
      // Tokens are spent last, the discount token checked (not spent) before the free-item one is spent.
      assertDiscountApprovable(ctx, gate)
      let freeBy: string | undefined
      if (!held && token !== undefined) {
        const used = overrides.consumeOverride(token, 'order.free_item')
        if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
        freeBy = used.value.byUserId
      }
      const audit = settleDiscount(ctx, gate)
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
