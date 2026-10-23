import type { OrderDto, PaymentDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { CASH_METHOD_CODE, paymentState } from '../../../domain/order/order'
import { computeTotals } from '../../../domain/order/totals'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import type { StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync, invalidInput } from '../users/outcome'
import { loadOrder, logOrder, reread, type Sales } from './context'
import { PaymentSchema, reasonOf, type AddPaymentInput } from './inputs'

export interface PaymentUseCases {
  /**
   * Takes a payment on an open order. Cash: `amountCents` is what the customer handed over; the part
   * applied is capped at what is due and the rest is change (`tenderedCents`, when given, is what was
   * handed over and may be above the amount); change is only given by a cash payment that settles the
   * order (`invalid_payment` otherwise). Any other method is charged what it says, never above what
   * is due (`overpay_non_cash`), and its `tenderedCents`, when given, must equal its amount. A zero or
   * negative amount is `invalid_payment`, an unknown or inactive method `unknown_payment_method`, a
   * paid-up order `nothing_due`.
   */
  addPayment(session: Session, orderId: string, input: AddPaymentInput): Result<OrderDto>
  /**
   * Takes a payment back off an open order, with a reason (one of `cancel.reasons` or free text). A card,
   * cheque or voucher payment was taken outside the till, so removing it needs `ticket.cancel` or
   * `overrideToken` for it (spent, logged as `overriddenBy`).
   */
  removePayment(session: Session, orderId: string, paymentId: string, reason: string, overrideToken?: OverrideToken): Result<OrderDto>
}

/** What the audit row of a payment records. */
const paymentData = (p: PaymentDto) => ({
  paymentId: p.id,
  methodCode: p.methodCode,
  amountCents: p.amountCents,
  tenderedCents: p.tenderedCents
})

/** The `payment.added` audit row of a payment taken inside a larger action (a split). */
export function logPayment(tx: Tx, session: Session, orderId: string, payment: PaymentDto): void {
  appendEvent(tx.db, { type: 'payment.added', entity: 'order', entityId: orderId, userId: session.userId, data: paymentData(payment) }, tx.clock)
}

/** Validates and stores one payment on `order`, inside the caller's transaction, and returns it. */
export function applyPayment(tx: Tx, ctx: Sales, session: Session, order: StoredOrder, raw: AddPaymentInput): PaymentDto {
  const input = parseInput(PaymentSchema, raw)
  const method = ctx.orders.paymentMethod(input.methodCode)
  if (!method || !method.active) throw new AppErrorException('unknown_payment_method', { methodCode: input.methodCode })
  const isCash = method.code === CASH_METHOD_CODE
  const { amountCents } = input
  const tendered = input.tenderedCents ?? amountCents
  const tenderOk = Number.isSafeInteger(tendered) && (!isCash || tendered >= amountCents)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !tenderOk) {
    throw new AppErrorException('invalid_payment', { methodCode: method.code, amountCents, tenderedCents: tendered })
  }
  const total = computeTotals(order.lines, order.discount).total
  const before = paymentState(total, order.payments)
  if (before.due === 0) throw new AppErrorException('nothing_due')
  const applied = isCash ? Math.min(amountCents, before.due) : amountCents
  // Change is given back only by the payment that settles the bill.
  if (isCash && applied < before.due && tendered > applied) {
    throw new AppErrorException('invalid_payment', { methodCode: method.code, amountCents, tenderedCents: tendered, reason: 'change_before_settled' })
  }
  const payment: PaymentDto = {
    id: newId(),
    methodCode: method.code,
    amountCents: applied,
    tenderedCents: tendered,
    createdAt: tx.clock.now().toISOString(),
    userId: session.userId
  }
  // The domain rule has the last word (non-cash above what is due, non-cash tendered != amount).
  paymentState(total, [...order.payments, payment])
  ctx.orders.insertPayment(tx, order.id, payment)
  return payment
}

export function createPaymentUseCases(ctx: Sales): PaymentUseCases {
  const { uow } = ctx

  function add(session: Session, orderId: string, raw: AddPaymentInput): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const payment = applyPayment(tx, ctx, session, order, raw)
      logOrder(tx, ctx, session, order, 'payment.added', paymentData(payment))
      return reread(ctx, order.id)
    })
  }

  function remove(session: Session, orderId: string, paymentId: string, rawReason: string, token?: OverrideToken): OrderDto {
    const reason = reasonOf(rawReason)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const payment = order.payments.find((p) => p.id === paymentId)
      if (!payment) throw invalidInput('paymentId', 'unknown payment')
      let overriddenBy: string | undefined
      if (payment.methodCode !== CASH_METHOD_CODE && !hasPermission(session, 'ticket.cancel')) {
        if (token === undefined) throw new AppErrorException('forbidden', { permission: 'ticket.cancel' })
        const used = ctx.overrides.consumeOverride(token, 'ticket.cancel')
        if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
        overriddenBy = used.value.byUserId
      }
      ctx.orders.deletePayment(tx, payment.id)
      logOrder(tx, ctx, session, order, 'payment.removed', { payment, reason, ...(overriddenBy ? { overriddenBy } : {}) })
      return reread(ctx, order.id)
    })
  }

  return {
    addPayment: (session, orderId, input) => attemptSync(() => add(session, orderId, input)),
    removePayment: (session, orderId, paymentId, reason, token) =>
      attemptSync(() => remove(session, orderId, paymentId, reason, token))
  }
}
