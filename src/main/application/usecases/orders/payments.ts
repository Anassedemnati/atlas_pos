import type { OrderDto, PaymentDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { CASH_METHOD_CODE, paymentState } from '../../../domain/order/order'
import { computeTotals } from '../../../domain/order/totals'
import type { Session } from '../../../domain/users/session'
import type { StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import type { Tx } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync, invalidInput } from '../users/outcome'
import { loadOrder, logOrder, reread, type Sales } from './context'
import { PaymentSchema, type AddPaymentInput } from './inputs'

export interface PaymentUseCases {
  /**
   * Takes a payment on an open order. Cash: `amountCents` is what the customer handed over; the part
   * applied is capped at what is due and the rest is change (`tenderedCents`, when given, is what was
   * handed over and may be above the amount). Any other method is charged what it says, never above what
   * is due (`overpay_non_cash`), and its `tenderedCents`, when given, must equal its amount. A zero or
   * negative amount is `invalid_payment`, an unknown or inactive method `unknown_payment_method`, a
   * paid-up order `nothing_due`.
   */
  addPayment(session: Session, orderId: string, input: AddPaymentInput): Result<OrderDto>
  removePayment(session: Session, orderId: string, paymentId: string): Result<OrderDto>
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
  const payment: PaymentDto = {
    id: newId(),
    methodCode: method.code,
    amountCents: isCash ? Math.min(amountCents, before.due) : amountCents,
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
      logOrder(tx, ctx, session, order, 'payment.added', {
        paymentId: payment.id,
        methodCode: payment.methodCode,
        amountCents: payment.amountCents,
        tenderedCents: payment.tenderedCents
      })
      return reread(ctx, order.id)
    })
  }

  function remove(session: Session, orderId: string, paymentId: string): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const payment = order.payments.find((p) => p.id === paymentId)
      if (!payment) throw invalidInput('paymentId', 'unknown payment')
      ctx.orders.deletePayment(tx, payment.id)
      logOrder(tx, ctx, session, order, 'payment.removed', { payment })
      return reread(ctx, order.id)
    })
  }

  return {
    addPayment: (session, orderId, input) => attemptSync(() => add(session, orderId, input)),
    removePayment: (session, orderId, paymentId) => attemptSync(() => remove(session, orderId, paymentId))
  }
}
