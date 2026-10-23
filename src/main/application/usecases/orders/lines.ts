import type { LineModifierDto, OrderDto, ProductDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { requirePermission, type OverrideToken, type Session } from '../../../domain/users/session'
import type { StoredLine, StoredOrder } from '../../../infrastructure/db/repos/orders-repo'
import { AppErrorException } from '../../errors'
import { parseInput } from '../catalog/input'
import { attemptSync, invalidInput } from '../users/outcome'
import {
  activeLine,
  assertNotBelowPaid,
  checkDiscountLimit,
  discountGate,
  loadOrder,
  logOrder,
  moveStock,
  reread,
  settleDiscount,
  type Sales
} from './context'
import { AddLineSchema, reasonOf, type AddLineInput } from './inputs'

export interface LineUseCases {
  /**
   * Adds a line to an open order and writes it at once. Name, price and VAT are copied from the product
   * (the ticket keeps them whatever the catalogue becomes), the stock of a tracked product goes down.
   * `invalid_qty` for a quantity that is not a whole number > 0, or not whole units for a product that
   * is not sold by weight; `invalid_modifiers` for a modifier that is not offered for the product, or a
   * group outside its min / max; `invalid_menu_choice` when the choices do not fill the set menu's courses.
   */
  addLine(session: Session, orderId: string, input: AddLineInput): Result<OrderDto>
  /**
   * A line the kitchen has not received yet (`line_sent` otherwise: void it, or add a line). Moves the
   * stock. A lower quantity shrinks what the order's discounts are measured on: `discount_over_limit`
   * unless `overrideToken` (see `setLineDiscount`).
   */
  setLineQty(session: Session, orderId: string, lineId: string, qtyMilli: number, overrideToken?: OverrideToken): Result<OrderDto>
  /**
   * Removes a line (it stays, as void, for the Z report). Before sending it is free; after, it needs
   * `order.void_sent` and a reason, and queues a kitchen "ANNULÉ" ticket. The stock comes back. The
   * order's discount is checked again as for `setLineQty`.
   */
  voidLine(session: Session, orderId: string, lineId: string, reason: string, overrideToken?: OverrideToken): Result<OrderDto>
}

/** Throws `invalid_qty` unless `qtyMilli` is a whole number > 0, in whole units unless sold by weight. */
function assertQty(qtyMilli: number, soldByWeight: boolean): void {
  const ok = Number.isSafeInteger(qtyMilli) && qtyMilli > 0 && (soldByWeight || qtyMilli % 1000 === 0)
  if (!ok) throw new AppErrorException('invalid_qty', { qtyMilli })
}

export function createLineUseCases(ctx: Sales): LineUseCases {
  const { uow, catalog } = ctx

  /** The chosen modifiers, checked against the product's groups (each id once, each group within min..max). */
  function modifiersFor(product: ProductDto, ids: string[]): LineModifierDto[] {
    if (new Set(ids).size !== ids.length) throw new AppErrorException('invalid_modifiers', { reason: 'duplicate' })
    const picked: LineModifierDto[] = []
    let matched = 0
    for (const groupId of product.modifierGroupIds) {
      const group = catalog.getModifierGroup(groupId)
      if (!group) continue
      const chosen = group.modifiers.filter((m) => ids.includes(m.id))
      if (chosen.length < group.minSelect || chosen.length > group.maxSelect) {
        throw new AppErrorException('invalid_modifiers', { groupId, min: group.minSelect, max: group.maxSelect })
      }
      matched += chosen.length
      picked.push(...chosen.map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })))
    }
    if (matched !== ids.length) throw new AppErrorException('invalid_modifiers', { reason: 'not_offered' })
    return picked
  }

  /** The set-menu choices as modifiers (id = chosen product, delta = supplement); none for a plain product. */
  function menuChoicesFor(product: ProductDto, choices: { courseId: string; productIds: string[] }[] | undefined): LineModifierDto[] {
    const courses = ctx.orders.menuCourses(product.id)
    if (!courses) {
      if (choices && choices.length > 0) throw new AppErrorException('invalid_menu_choice', { reason: 'not_a_menu' })
      return []
    }
    const given = choices ?? []
    const known = new Set(courses.map((c) => c.id))
    if (given.some((c) => !known.has(c.courseId)) || new Set(given.map((c) => c.courseId)).size !== given.length) {
      throw new AppErrorException('invalid_menu_choice', { reason: 'unknown_course' })
    }
    return courses.flatMap((course) => {
      const ids = given.find((c) => c.courseId === course.id)?.productIds ?? []
      if (ids.length !== course.chooseCount) throw new AppErrorException('invalid_menu_choice', { courseId: course.id })
      return ids.map((productId) => {
        const item = course.items.find((i) => i.productId === productId)
        const chosen = item && catalog.getProduct(productId)
        if (!item || !chosen) throw new AppErrorException('invalid_menu_choice', { courseId: course.id, productId })
        if (!chosen.active) throw new AppErrorException('product_inactive', { productId })
        return { id: productId, name: chosen.name, priceDeltaCents: item.supplementCents, menuCourseId: course.id }
      })
    })
  }

  function add(session: Session, orderId: string, raw: AddLineInput): OrderDto {
    const input = parseInput(AddLineSchema, raw)
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const product = catalog.getProduct(input.productId)
      if (!product || !product.active) throw invalidInput('productId', 'unknown product')
      assertQty(input.qtyMilli, product.soldByWeight)
      const line: StoredLine = {
        id: newId(),
        seq: ctx.orders.nextSeq(order.id),
        productId: product.id,
        name: product.name,
        qtyMilli: input.qtyMilli,
        unitPriceCents: product.priceCents,
        vatBp: product.vatBp,
        modifiers: [...modifiersFor(product, input.modifierIds), ...menuChoicesFor(product, input.menuChoices)],
        note: input.note,
        course: product.course,
        status: 'active',
        voidReason: '',
        sentAt: null,
        discount: null,
        free: false,
        freeReason: '',
        userId: session.userId,
        createdAt: tx.clock.now().toISOString()
      }
      ctx.orders.insertLine(tx, order.id, line)
      moveStock(tx, ctx, line, -1)
      logOrder(tx, ctx, session, order, 'order.line_added', {
        lineId: line.id,
        productId: product.id,
        qtyMilli: line.qtyMilli,
        unitPriceCents: line.unitPriceCents
      })
      return reread(ctx, order.id)
    })
  }

  /**
   * Checks the order once one of its lines becomes `changed` and settles its discount check (the token,
   * if needed, is spent here: every other check of the action has passed). Returns the audit data.
   */
  function recheck(session: Session, order: StoredOrder, changed: StoredLine, token: OverrideToken | undefined) {
    const lines = order.lines.map((l) => (l.id === changed.id ? changed : l))
    assertNotBelowPaid(lines, order.discount, order.payments)
    const gate = discountGate(token)
    order.discountApprovedBp = checkDiscountLimit(session, gate, { lines, discount: order.discount, approvedBp: order.discountApprovedBp })
    return settleDiscount(ctx, gate)
  }

  function setQty(session: Session, orderId: string, lineId: string, qtyMilli: number, token?: OverrideToken): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      if (line.sentAt !== null) throw new AppErrorException('line_sent', { lineId })
      assertQty(qtyMilli, catalog.getProduct(line.productId)?.soldByWeight ?? false)
      const updated = { ...line, qtyMilli }
      const audit = recheck(session, order, updated, token)
      ctx.orders.updateLine(tx, updated)
      // Only the difference moves: a lower quantity puts stock back, a higher one takes more.
      if (qtyMilli !== line.qtyMilli) moveStock(tx, ctx, { ...line, qtyMilli: line.qtyMilli - qtyMilli }, 1)
      logOrder(tx, ctx, session, order, 'order.line_qty', { lineId, from: line.qtyMilli, to: qtyMilli, ...audit })
      return reread(ctx, order.id)
    })
  }

  function voidIt(session: Session, orderId: string, lineId: string, rawReason: string, token?: OverrideToken): OrderDto {
    return uow.run((tx) => {
      const order = loadOrder(ctx, orderId)
      const line = activeLine(order, lineId)
      const sent = line.sentAt !== null
      if (sent) requirePermission(session, 'order.void_sent')
      const reason = sent ? reasonOf(rawReason) : typeof rawReason === 'string' ? rawReason.trim() : ''
      const voided: StoredLine = { ...line, status: 'void', voidReason: reason }
      const audit = recheck(session, order, voided, token)
      ctx.orders.updateLine(tx, voided)
      moveStock(tx, ctx, line, 1)
      if (sent) ctx.spooler.enqueue(tx, { target: { role: 'kitchen' }, kind: 'kitchen-cancel', payload: { orderId: order.id, lineIds: [lineId] } })
      logOrder(tx, ctx, session, order, 'order.line_void', { lineId, reason, sent, qtyMilli: line.qtyMilli, ...audit })
      return reread(ctx, order.id)
    })
  }

  return {
    addLine: (session, orderId, input) => attemptSync(() => add(session, orderId, input)),
    setLineQty: (session, orderId, lineId, qtyMilli, token) => attemptSync(() => setQty(session, orderId, lineId, qtyMilli, token)),
    voidLine: (session, orderId, lineId, reason, token) => attemptSync(() => voidIt(session, orderId, lineId, reason, token))
  }
}
