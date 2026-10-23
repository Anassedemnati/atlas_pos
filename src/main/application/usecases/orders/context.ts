import type { LineModifierDto, OrderDto, PaymentDto } from '@shared/dto'
import type { Discount } from '../../../domain/order/discount'
import { lineGross, lineNet, type OrderLine } from '../../../domain/order/line'
import { activeLines, paymentState, type OrderStatus } from '../../../domain/order/order'
import { computeTotals } from '../../../domain/order/totals'
import { hasPermission, type OverrideToken, type Session } from '../../../domain/users/session'
import type { Database } from '../../../infrastructure/db/connection'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { createCatalogRepo, type CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import { createCustomersRepo, type CustomersRepo } from '../../../infrastructure/db/repos/customers-repo'
import { createDaysRepo, type DaysRepo } from '../../../infrastructure/db/repos/days-repo'
import {
  createOrdersRepo,
  type OrdersRepo,
  type StoredLine,
  type StoredOrder
} from '../../../infrastructure/db/repos/orders-repo'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import { createTicketsRepo, type TicketsRepo } from '../../../infrastructure/db/repos/tickets-repo'
import type { Tx, UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import type { Clock, FullBackupTrigger, PrintSpooler } from '../../ports'
import type { OverrideUseCases } from '../users/override'
import { invalidInput } from '../users/outcome'

/** What the order, ticket, day and customer use cases are built from. */
export interface SalesDeps {
  db: Database
  uow: UnitOfWork
  clock: Clock
  settings: SettingsRepo
  spooler: PrintSpooler
  /** The users service of the process: it holds the override tokens a manager issued. */
  overrides: Pick<OverrideUseCases, 'consumeOverride'>
  /** Asked for a full backup after each Z (when `backup.onClose` is on). */
  backup?: FullBackupTrigger
}

export interface Sales extends SalesDeps {
  orders: OrdersRepo
  tickets: TicketsRepo
  days: DaysRepo
  customers: CustomersRepo
  catalog: CatalogRepo
}

export function salesContext(deps: SalesDeps): Sales {
  return {
    ...deps,
    orders: createOrdersRepo(deps.db),
    tickets: createTicketsRepo(deps.db),
    days: createDaysRepo(deps.db),
    customers: createCustomersRepo(deps.db),
    catalog: createCatalogRepo(deps.db)
  }
}

export function toOrderDto(order: StoredOrder): OrderDto {
  const totals = computeTotals(order.lines, order.discount)
  const nets = new Map(totals.perLine.map((p) => [p.lineId, p.net]))
  const { paid, due, change } = paymentState(totals.total, order.payments)
  return {
    id: order.id,
    dayId: order.dayId,
    type: order.type,
    tableId: order.tableId,
    tableLabel: order.tableLabel,
    covers: order.covers,
    orderNumber: order.orderNumber,
    status: order.status,
    userId: order.userId,
    customerId: order.customerId,
    openedAt: order.openedAt,
    updatedAt: order.updatedAt,
    note: order.note,
    discount: order.discount,
    discountApprovedBp: order.discountApprovedBp,
    lines: order.lines.map((line) => ({ ...line, netCents: nets.get(line.id) ?? 0 })),
    payments: order.payments,
    totals: {
      grossCents: totals.gross,
      lineDiscountsCents: totals.lineDiscounts,
      ticketDiscountCents: totals.ticketDiscount,
      totalCents: totals.total,
      vat: totals.vat
    },
    paidCents: paid,
    dueCents: due,
    changeCents: change
  }
}

/** The order, or `invalid_input` when there is none and `order_not_open` when its status is not one of `allowed`. */
export function loadOrder(ctx: Sales, id: string, allowed: readonly OrderStatus[] = ['open']): StoredOrder {
  const order = typeof id === 'string' ? ctx.orders.get(id) : undefined
  if (!order) throw invalidInput('orderId', 'unknown order')
  if (!allowed.includes(order.status)) throw new AppErrorException('order_not_open', { status: order.status })
  return order
}

export function findLine(order: StoredOrder, lineId: string): StoredLine {
  const line = order.lines.find((l) => l.id === lineId)
  if (!line) throw invalidInput('lineId', 'unknown line')
  return line
}

/** An active line, `line_void` otherwise. */
export function activeLine(order: StoredOrder, lineId: string): StoredLine {
  const line = findLine(order, lineId)
  if (line.status !== 'active') throw new AppErrorException('line_void', { lineId })
  return line
}

/** Refuses (`below_paid`) a change that would take the bill under what was already paid: remove a payment first. */
export function assertNotBelowPaid(lines: StoredLine[], discount: Discount | null, payments: PaymentDto[]): void {
  const total = computeTotals(lines, discount).total
  const paid = payments.reduce((sum, p) => sum + p.amountCents, 0)
  if (total < paid) throw new AppErrorException('below_paid', { totalCents: total, paidCents: paid })
}

/**
 * A manager approval offered for one action (`order.discount.override`). It is spent at most once,
 * however many orders the action checks (`moveLines`, a split), and only if a check needs it; `usedBy`
 * then names the manager, for the action's audit row.
 */
export interface DiscountApproval {
  token?: OverrideToken
  usedBy?: string
}

/**
 * The combined discount of an order, measured on what was granted rather than on what the amounts
 * happen to take off now: `granted` is in centimes x 10000 (a percentage counts its exact share of its
 * base, a fixed amount its full nominal value, even above its base), `base` the gross of the active lines
 * that are not free. Free items are governed by `order.free_item`, not by the discount limit.
 */
export function discountMeasure(lines: OrderLine[], discount: Discount | null): { granted: number; base: number } {
  let granted = 0
  let base = 0
  let nets = 0
  for (const line of activeLines(lines).filter((l) => !l.free)) {
    const gross = lineGross(line)
    base += gross
    nets += lineNet(line)
    if (line.discount) granted += line.discount.kind === 'pct' ? gross * line.discount.bp : line.discount.cents * 10000
  }
  if (discount) granted += discount.kind === 'pct' ? nets * discount.bp : discount.cents * 10000
  return { granted, base }
}

/** The combined discount in basis points, rounded up and at most 10000; a discount on a zero base is 10000. */
export function effectiveDiscountBp(m: { granted: number; base: number }): number {
  if (m.granted === 0) return 0
  if (m.base === 0) return 10000
  return Math.min(10000, Math.ceil(m.granted / m.base))
}

/**
 * Checks the order's combined discount (as it will be after the change) against what the acting session
 * may allow: `max(session.maxDiscountBp, order approval)`; a session holding `order.discount.override` is
 * not limited. Above it, the approval's token is spent (once) or the change is refused with
 * `discount_over_limit` (`params.effectiveBp`, `params.limitBp`) so the till can ask for a manager PIN.
 * Returns the order's new approval: raised to the effective discount when a manager approved it (an
 * override, or an unlimited session), and also when `grant` (the action sets a discount, which the
 * session has just authorised within its own limit).
 */
export function enforceDiscountLimit(
  ctx: Sales,
  session: Session,
  after: { lines: OrderLine[]; discount: Discount | null; approvedBp: number | null },
  approval: DiscountApproval = {},
  grant = false
): number | null {
  const measure = discountMeasure(after.lines, after.discount)
  const effectiveBp = effectiveDiscountBp(measure)
  if (effectiveBp === 0) return after.approvedBp
  const raised = Math.max(after.approvedBp ?? 0, effectiveBp)
  if (hasPermission(session, 'order.discount.override')) return raised
  const limitBp = Math.max(session.maxDiscountBp, after.approvedBp ?? 0)
  // Exact: granted / base <= limit, without rounding a 10 % on an odd amount into 10,01 %.
  if (measure.base > 0 && measure.granted <= limitBp * measure.base) return grant ? raised : after.approvedBp
  if (approval.usedBy === undefined) {
    if (approval.token === undefined) throw new AppErrorException('discount_over_limit', { effectiveBp, limitBp })
    const used = ctx.overrides.consumeOverride(approval.token, 'order.discount.override')
    if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
    approval.usedBy = used.value.byUserId
  }
  return raised
}

/**
 * The audit row of a change to an order (one per use case) and `order.changed` once it commits; also
 * stamps the order's `updated_at`.
 */
export function logOrder(tx: Tx, ctx: Sales, session: Session, order: StoredOrder, type: string, data?: unknown): void {
  ctx.orders.updateHeader(tx, { ...order, updatedAt: tx.clock.now().toISOString() })
  appendEvent(tx.db, { type, entity: 'order', entityId: order.id, userId: session.userId, data }, tx.clock)
  tx.events.push({ type: 'order.changed', orderId: order.id })
}

/**
 * Moves the stock of what a line sold: the product and its set-menu choices, each `qtyMilli`, for the
 * products that track their stock. `sign` -1 takes it out (a sale), +1 puts it back (a void, a credit).
 */
export function moveStock(
  tx: Tx,
  ctx: Sales,
  line: { productId: string; qtyMilli: number; modifiers: LineModifierDto[] },
  sign: 1 | -1
): void {
  const ids = [line.productId, ...line.modifiers.filter((m) => m.menuCourseId !== undefined).map((m) => m.id)]
  for (const id of ids) {
    if (ctx.catalog.getProduct(id)?.stockTracked) ctx.catalog.addStock(tx, id, sign * line.qtyMilli)
  }
}

/** Re-reads the order after a change, as the DTO the till shows. */
export function reread(ctx: Sales, orderId: string): OrderDto {
  return toOrderDto(loadOrder(ctx, orderId, ['open', 'parked', 'closed', 'cancelled']))
}
