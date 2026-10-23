import type { LineModifierDto, OrderDto, PaymentDto } from '@shared/dto'
import type { Discount } from '../../../domain/order/discount'
import type { OrderLine } from '../../../domain/order/line'
import { activeLines, paymentState, type OrderStatus } from '../../../domain/order/order'
import { computeTotals, priceLines } from '../../../domain/order/totals'
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
  overrides: Pick<OverrideUseCases, 'consumeOverride' | 'isOverrideValid'>
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
    approvedTicketBp: order.approvedTicketBp,
    approvedCents: order.approvedCents,
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
 * The discount checks of one action, settled once at its end. Each order the action touches is checked
 * as it will be; if any is over what the acting session may allow, the manager's `token` (for
 * `order.discount.override`) is spent once for the whole action, after every other check passed, or the
 * action is refused. `usedBy` then names the manager, for the audit row.
 */
export interface DiscountGate {
  token?: OverrideToken
  checks: { discountCents: number; limitCents: number; over: boolean }[]
  usedBy?: string
}

export const discountGate = (token?: OverrideToken): DiscountGate => ({ token, checks: [] })

/** What a manager approved on an order, beyond the acting user's own limit (migration 005). */
export interface Approvals {
  /** A percentage approval, only for a 'pct' ticket discount; it follows the bill. */
  approvedTicketBp: number
  /** An absolute budget for amount discounts (ticket 'amount') and all line discounts. */
  approvedCents: number
}

export const approvalsOf = (order: Approvals): Approvals => ({
  approvedTicketBp: order.approvedTicketBp,
  approvedCents: order.approvedCents
})

/**
 * The money an order's discounts take off, measured on the active lines that are not free (free items
 * are governed by `order.free_item`, not by the discount limit): `discountCents` is the line discounts
 * plus the ticket discount exactly as the ticket computes them, `gross` the gross of those lines, and
 * `discountedLines` how many of them take a centime or more off (each may carry a rounding centime).
 */
export interface DiscountFigures {
  discountCents: number
  gross: number
  discountedLines: number
}

export function discountFigures(lines: OrderLine[], discount: Discount | null): DiscountFigures {
  const free = new Set(lines.filter((l) => l.free).map((l) => l.id))
  const figures: DiscountFigures = { discountCents: 0, gross: 0, discountedLines: 0 }
  for (const priced of priceLines(lines, discount)) {
    if (free.has(priced.lineId)) continue
    const off = priced.lineDiscount + priced.ticketDiscount
    figures.gross += priced.gross
    figures.discountCents += off
    if (off > 0) figures.discountedLines += 1
  }
  return figures
}

/** `bp` of `gross`, rounded to the centime, plus the rounding centime of each discounted line. */
const pctTermCents = (bp: number, figures: DiscountFigures): number =>
  Math.round((bp * figures.gross) / 10000) + figures.discountedLines

/**
 * The most an order state may take off for `session`: its own limit as a share of the gross, or what a
 * manager approved (the ticket percentage as a share of the gross, plus the budget in centimes),
 * whichever is more.
 */
export function discountLimitCents(session: Session, approvals: Approvals, figures: DiscountFigures): number {
  return Math.max(
    pctTermCents(session.maxDiscountBp, figures),
    pctTermCents(approvals.approvedTicketBp, figures) + approvals.approvedCents
  )
}

export interface DiscountCheck {
  /** Over the limit for a limited session: the action goes on only if the gate's token is spent. */
  over: boolean
  /**
   * What the order carries after the action: `approvals` as given, or, when the state needed a manager
   * (over the limit with a token, or an unlimited session), the budget raised to cover the state, so
   * the manager is not asked again at close for what was approved.
   */
  approvals: Approvals
}

/**
 * Records the check of one order state (its lines and ticket discount as they will be) under `approvals`:
 * its discount must stay within `discountLimitCents`. A session holding `order.discount.override` is not
 * limited; its pass is recorded whenever the state goes beyond what the order's own approvals cover. See
 * `DiscountCheck`; a check that is over without a token makes `settleDiscount` refuse the action, so its
 * raised approvals are never written.
 */
export function checkDiscountLimit(
  session: Session,
  gate: DiscountGate,
  state: { lines: OrderLine[]; discount: Discount | null },
  approvals: Approvals
): DiscountCheck {
  const figures = discountFigures(state.lines, state.discount)
  const limitCents = discountLimitCents(session, approvals, figures)
  const unlimited = hasPermission(session, 'order.discount.override')
  const approvedTerm = pctTermCents(approvals.approvedTicketBp, figures) + approvals.approvedCents
  const needsManager = figures.discountCents > (unlimited ? approvedTerm : limitCents)
  const over = needsManager && !unlimited
  gate.checks.push({ discountCents: figures.discountCents, limitCents, over })
  if (!needsManager) return { over, approvals }
  const uncovered = figures.discountCents - Math.round((approvals.approvedTicketBp * figures.gross) / 10000)
  return { over, approvals: { ...approvals, approvedCents: Math.max(approvals.approvedCents, uncovered) } }
}

/** Whether the order carries anything the budget covers: an amount ticket discount or a line discount. */
const carriesBudgeted = (lines: OrderLine[], discount: Discount | null): boolean =>
  discount?.kind === 'amount' || activeLines(lines).some((l) => !l.free && l.discount !== null)

/**
 * The approvals an order carries once its ticket discount (`change` 'ticket') or a line discount
 * ('line') was set, changed or removed. Without a manager (`viaManager` false), the ticket percentage
 * approval follows a 'pct' ticket discount but never exceeds what the session may give on its own, or
 * what was approved before; the budget is untouched, and cleared once nothing it covers is left. With a
 * manager (an unlimited session, or a token the gate spends), the ticket percentage is approved as set
 * and the budget grows to cover whatever the ticket percentage does not. Base changes (lines added,
 * quantities, voids, free items, moves, merges, splits, closing) never go through here: they are only
 * checked, and raise the budget only when a manager passed them (`checkDiscountLimit`).
 */
export function approvalsAfterDiscount(
  previous: Approvals,
  session: Session,
  after: { lines: OrderLine[]; discount: Discount | null },
  change: 'ticket' | 'line',
  viaManager: boolean
): Approvals {
  let approvedTicketBp = previous.approvedTicketBp
  if (change === 'ticket') {
    const ticket = after.discount
    if (ticket?.kind !== 'pct') approvedTicketBp = 0
    else if (viaManager) approvedTicketBp = ticket.bp
    else approvedTicketBp = Math.min(ticket.bp, Math.max(session.maxDiscountBp, previous.approvedTicketBp))
  }
  const budgeted = carriesBudgeted(after.lines, after.discount)
  let approvedCents = budgeted ? previous.approvedCents : 0
  if (budgeted && viaManager) {
    const figures = discountFigures(after.lines, after.discount)
    approvedCents = Math.max(approvedCents, figures.discountCents - Math.round((approvedTicketBp * figures.gross) / 10000))
  }
  return { approvedTicketBp, approvedCents }
}

/**
 * Throws `discount_over_limit` (the first order over, `params.discountCents` / `params.limitCents`) when
 * a check of the gate is over and no token was offered, and `forbidden` (`reason: override_invalid`) when
 * the token offered would not be accepted. Spends nothing.
 */
export function assertDiscountApprovable(ctx: Sales, gate: DiscountGate): void {
  const over = gate.checks.find((c) => c.over)
  if (!over || gate.usedBy !== undefined) return
  if (gate.token === undefined) {
    throw new AppErrorException('discount_over_limit', { discountCents: over.discountCents, limitCents: over.limitCents })
  }
  if (!ctx.overrides.isOverrideValid(gate.token, 'order.discount.override')) {
    throw new AppErrorException('forbidden', { permission: 'order.discount.override', reason: 'override_invalid' })
  }
}

/**
 * Ends the action's discount checks: nothing to do when all are within limits, else the token is spent
 * (or the action refused). Call it last, once every other check of the action has passed; the writes
 * already made roll back with the transaction if it throws. Returns the audit data (`overriddenBy`).
 */
export function settleDiscount(ctx: Sales, gate: DiscountGate): { overriddenBy?: string } {
  assertDiscountApprovable(ctx, gate)
  if (gate.checks.some((c) => c.over) && gate.usedBy === undefined && gate.token !== undefined) {
    const used = ctx.overrides.consumeOverride(gate.token, 'order.discount.override')
    if (!used.ok) throw new AppErrorException(used.error.code, used.error.params)
    gate.usedBy = used.value.byUserId
  }
  return gate.usedBy === undefined ? {} : { overriddenBy: gate.usedBy }
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
