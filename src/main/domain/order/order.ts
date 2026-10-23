import type { OrderStatus, OrderType } from '@shared/dto'
import { AppErrorException } from '../../application/errors'
import type { Discount } from './discount'
import type { OrderLine } from './line'

export type { OrderStatus, OrderType }

/** An order as the use cases work on it: the `orders` row, its ticket discount and its lines. */
export interface Order {
  id: string
  dayId: string
  type: OrderType
  tableId: string | null
  covers: number
  /** 1-999, reset per business day; null until the order has one. */
  orderNumber: number | null
  status: OrderStatus
  userId: string
  customerId: string | null
  openedAt: string
  updatedAt: string
  note: string
  discount: Discount | null
  /** The order's combined discount (bp) as last approved (see migration 005); null when none. */
  discountApprovedBp: number | null
  lines: OrderLine[]
}

/** The lines that are not void, in the order given. */
export function activeLines<L extends OrderLine>(lines: L[]): L[] {
  return lines.filter((line) => line.status === 'active')
}

/**
 * The active lines the kitchen has not received yet, in the order given. With `uptoCourse`, only those
 * of that course or an earlier one (course 0, no course, always goes with the first batch): "send next course".
 */
export function unsentLines<L extends OrderLine>(lines: L[], uptoCourse?: number): L[] {
  return activeLines(lines).filter((line) => line.sentAt === null && (uptoCourse === undefined || line.course <= uptoCourse))
}

/** The method code of cash, the only one that gives change. */
export const CASH_METHOD_CODE = 'cash'

/**
 * One payment on an order: `amountCents` is the part applied to the bill, `tenderedCents` what the customer
 * handed over (more than the amount for cash; equal to it for any other method).
 */
export interface PaymentInput {
  methodCode: string
  amountCents: number
  tenderedCents: number
}

export interface PaymentState {
  paid: number
  /** Still to pay, never negative. */
  due: number
  /** Cash given back: what was tendered above what was applied, over the cash payments. */
  change: number
}

const isCents = (n: number): boolean => Number.isSafeInteger(n) && n >= 0

/**
 * Where an order stands against its total, payments taken in the order given. A payment that takes `paid`
 * above the total is refused: `overpay_non_cash` when it is not cash (a card is charged what is due, no more),
 * `invalid_payment` when it is cash (the amount applied is capped at what is due; the surplus is only in `tenderedCents`).
 * `invalid_payment` also for an amount that is not whole centimes > 0, cash tendered below its amount, or
 * another method whose tendered differs from its amount.
 */
export function paymentState(totalCents: number, payments: PaymentInput[]): PaymentState {
  if (!isCents(totalCents)) throw new AppErrorException('invalid_payment', { field: 'total', totalCents })
  let paid = 0
  let change = 0
  for (const payment of payments) {
    const { methodCode, amountCents, tenderedCents } = payment
    const isCash = methodCode === CASH_METHOD_CODE
    const tenderOk = isCash ? tenderedCents >= amountCents : tenderedCents === amountCents
    if (!isCents(amountCents) || amountCents === 0 || !isCents(tenderedCents) || !tenderOk) {
      throw new AppErrorException('invalid_payment', { methodCode, amountCents, tenderedCents })
    }
    paid += amountCents
    if (paid > totalCents) {
      throw new AppErrorException(isCash ? 'invalid_payment' : 'overpay_non_cash', { methodCode, amountCents, totalCents })
    }
    if (isCash) change += tenderedCents - amountCents
  }
  return { paid, due: totalCents - paid, change }
}
