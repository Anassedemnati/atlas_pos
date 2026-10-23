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
    ownGrantBp: order.ownGrantBp,
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

/**
 * The grants an order carries (migration 005), each recorded by its grantor only and added up into the
 * allowance: staff authority, a manager's ticket percentage and a manager's budget.
 */
export interface Approvals {
  /** The highest own-limit percentage a limited session legitimately used on the order; never reduced. */
  ownGrantBp: number
  /** A manager's ticket percentage beyond the staff authority in force, only with a 'pct' ticket discount; it follows the bill. */
  approvedTicketBp: number
  /** A manager's budget in centimes beyond everything else the order allows, in increments; it never grows with the bill. */
  approvedCents: number
}

export const approvalsOf = (order: Approvals): Approvals => ({
  ownGrantBp: order.ownGrantBp,
  approvedTicketBp: order.approvedTicketBp,
  approvedCents: order.approvedCents
})

/** Writes `approvals` on the order (or order copy) about to be stored. */
export function applyApprovals(order: Approvals, approvals: Approvals): void {
  order.ownGrantBp = approvals.ownGrantBp
  order.approvedTicketBp = approvals.approvedTicketBp
  order.approvedCents = approvals.approvedCents
}

/** A session holding `order.discount.override` is not limited; every other one is, by its `maxDiscountBp`. */
export const isLimited = (session: Session): boolean => !hasPermission(session, 'order.discount.override')

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

/** `bp` of the figures' gross, rounded to the centime. */
const pctCents = (bp: number, figures: DiscountFigures): number => Math.round((bp * figures.gross) / 10000)

/** ceil(a / b) for safe integers, exact (b > 0). */
const ceilDiv = (a: number, b: number): number => {
  const q = Math.floor(a / b)
  return q * b < a ? q + 1 : q
}

/**
 * The staff percentage in force for `session` on an order: its own limit, or what a limited session
 * already used on the order legitimately, whichever is more. An unlimited session brings no percentage of
 * its own (its authority is not a limit): only `ownGrantBp` counts for it.
 */
export const staffBpInForce = (session: Session, approvals: Approvals): number =>
  Math.max(isLimited(session) ? session.maxDiscountBp : 0, approvals.ownGrantBp)

const allowanceFor = (staffBp: number, approvals: Approvals, figures: DiscountFigures): number =>
  pctCents(staffBp, figures) + figures.discountedLines + pctCents(approvals.approvedTicketBp, figures) + approvals.approvedCents

/**
 * The most an order state may take off for `session`, added up: the staff percentage in force as a
 * share of the gross, a rounding centime per discounted line, the manager's ticket percentage as a share
 * of the gross, and the manager's budget.
 */
export const allowanceCents = (session: Session, approvals: Approvals, figures: DiscountFigures): number =>
  allowanceFor(staffBpInForce(session, approvals), approvals, figures)

/** What the order's own grants allow, no session's limit added: how a piece of a split is judged. */
export const grantedCents = (approvals: Approvals, figures: DiscountFigures): number =>
  allowanceFor(approvals.ownGrantBp, approvals, figures)

/** Whether the order carries anything the budget covers: an amount ticket discount or a line discount. */
const carriesBudgeted = (lines: OrderLine[], discount: Discount | null): boolean =>
  discount?.kind === 'amount' || activeLines(lines).some((l) => !l.free && l.discount !== null)

/** Rule 5: once no line discount and no amount ticket discount is left, the budget is 0. */
const budgetKept = (approvals: Approvals, state: { lines: OrderLine[]; discount: Discount | null }): Approvals =>
  carriesBudgeted(state.lines, state.discount) ? approvals : { ...approvals, approvedCents: 0 }

/**
 * Rule 1: the staff authority a limited session's pass without a token records: the state's percentage
 * of the gross (rounded up), capped at the session's own limit, never less than before.
 */
const ownGrantAfter = (session: Session, approvals: Approvals, figures: DiscountFigures): number => {
  const used = figures.gross > 0 ? ceilDiv(figures.discountCents * 10000, figures.gross) : 0
  return Math.max(approvals.ownGrantBp, Math.min(session.maxDiscountBp, used))
}

/**
 * Rules 2 and 3: a manager's pass adds to the budget what the state takes off beyond the allowance the
 * order already gives `session` (the acting session's own limit counts for a limited one, only
 * `ownGrantBp` for an unlimited one): a no-op, a removal or a covered change adds 0.
 */
const budgetRaised = (session: Session, approvals: Approvals, figures: DiscountFigures): Approvals => ({
  ...approvals,
  approvedCents: approvals.approvedCents + Math.max(0, figures.discountCents - allowanceCents(session, approvals, figures))
})

export interface DiscountCheck {
  /** Over the allowance for a limited session: the action goes on only if the gate's token is spent. */
  over: boolean
  /** What the order carries after the action (see `checkDiscountLimit`). */
  approvals: Approvals
}

/**
 * Records the check of one order state (its lines and ticket discount as they will be) under `approvals`:
 * its discount must stay within `allowanceCents`. A session holding `order.discount.override` is not
 * limited. A change that grows the bill (a line added, a higher quantity, a merge, lines moved in) or
 * closes it never records anything: `approvals` come back as given. `shrinks` marks a change that shrinks
 * what the discounts are measured on (a void, a lower quantity, a free item, lines moved out, what a
 * split leaves); what it leaves is recorded: a budget nothing covers any more is cleared (rule 5), a
 * limited session's pass within the allowance records its staff authority (rule 1), its pass on the
 * gate's token adds to the budget what the state takes off beyond the allowance (rule 3), and an
 * unlimited session's own base change records nothing. A check that is over without a token makes
 * `settleDiscount` refuse the action, so nothing raised is written.
 */
export function checkDiscountLimit(
  session: Session,
  gate: DiscountGate,
  state: { lines: OrderLine[]; discount: Discount | null },
  approvals: Approvals,
  shrinks = false
): DiscountCheck {
  const figures = discountFigures(state.lines, state.discount)
  const limitCents = allowanceCents(session, approvals, figures)
  const over = figures.discountCents > limitCents && isLimited(session)
  gate.checks.push({ discountCents: figures.discountCents, limitCents, over })
  if (!shrinks) return { over, approvals }
  const kept = budgetKept(approvals, state)
  if (!isLimited(session)) return { over, approvals: kept }
  if (!over) return { over, approvals: { ...kept, ownGrantBp: ownGrantAfter(session, kept, figures) } }
  return { over, approvals: budgetRaised(session, kept, figures) }
}

/** Rule 5 for the setters: a ticket discount that is no longer a percentage leaves no ticket percentage approval. */
const ticketKept = (approvals: Approvals, after: { discount: Discount | null }, change: 'ticket' | 'line'): Approvals =>
  change === 'ticket' && after.discount?.kind !== 'pct' ? { ...approvals, approvedTicketBp: 0 } : approvals

/**
 * What the order carries once a limited `session` set its ticket discount (`change` 'ticket') or a line
 * discount ('line') within the allowance, without a token (rules 1 and 5): a budget nothing covers any
 * more and a ticket percentage approval without a 'pct' ticket discount are cleared, and the staff
 * authority used is recorded. Nothing else changes.
 */
export function approvalsAfterOwnDiscount(
  previous: Approvals,
  session: Session,
  after: { lines: OrderLine[]; discount: Discount | null },
  change: 'ticket' | 'line'
): Approvals {
  const kept = ticketKept(budgetKept(previous, after), after, change)
  if (!isLimited(session)) return kept
  return { ...kept, ownGrantBp: ownGrantAfter(session, kept, discountFigures(after.lines, after.discount)) }
}

/** What a state takes off beyond the allowance the order gives `session` under `approvals`; negative when within it. */
const gapCents = (session: Session, approvals: Approvals, state: { lines: OrderLine[]; discount: Discount | null }): number => {
  const figures = discountFigures(state.lines, state.discount)
  return figures.discountCents - allowanceCents(session, approvals, figures)
}

/**
 * What the order carries once a manager passed the discount `session` set (an unlimited session, or a
 * token the gate spends), rules 2 and 5. After the clearing of rule 5: a 'pct' ticket discount of `B`
 * approves the ticket percentage beyond the staff percentage in force, `B − staffBpInForce`, never less
 * than before; any other setter adds to the budget the gap the setter itself caused,
 * `max(0, gap(after) − max(0, gap(before)))`, both gaps under the same stored values and the same
 * session: a no-op, a removal or a change already covered adds 0, and a gap that was there before the
 * setter (a manager's own voids, a token pass of a smaller limit) is not booked by a setter that did not
 * cause it. No staff authority is recorded by a token pass.
 */
export function approvalsAfterApprovedDiscount(
  previous: Approvals,
  session: Session,
  before: { lines: OrderLine[]; discount: Discount | null },
  after: { lines: OrderLine[]; discount: Discount | null },
  change: 'ticket' | 'line'
): Approvals {
  const kept = ticketKept(budgetKept(previous, after), after, change)
  if (change === 'ticket' && after.discount?.kind === 'pct') {
    const beyondStaff = after.discount.bp - staffBpInForce(session, kept)
    return { ...kept, approvedTicketBp: Math.max(kept.approvedTicketBp, beyondStaff) }
  }
  const caused = gapCents(session, kept, after) - Math.max(0, gapCents(session, kept, before))
  return { ...kept, approvedCents: kept.approvedCents + Math.max(0, caused) }
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
