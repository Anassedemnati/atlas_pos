import { z } from 'zod'
import type { OrderDto, TicketDto } from '../dto'
import { def, discount, id, int, text, tokenId } from './define'

const payment = z.strictObject({ methodCode: z.string().max(32), amountCents: int, tenderedCents: int.optional() })
const order = { orderId: id }
const line = { orderId: id, lineId: id }

/**
 * Orders at the till. `overrideTokenId` is the `id` of a manager's approval (`users.authorizeOverride`)
 * for an action the session may not do alone.
 */
export const ordersChannels = {
  'orders.open': def<OrderDto>()(
    z.strictObject({
      type: z.enum(['dine_in', 'takeaway', 'delivery', 'counter']),
      tableId: id.optional(),
      covers: int.optional(),
      customerId: id.optional()
    }),
    'session'
  ),
  'orders.get': def<OrderDto>()(z.strictObject(order), 'session'),
  /** The order's note, or with `lineId` a line's. */
  'orders.setNote': def<OrderDto>()(z.strictObject({ ...order, note: text, lineId: id.optional() }), 'session'),
  'orders.setCovers': def<OrderDto>()(z.strictObject({ ...order, covers: int }), 'session'),
  'orders.assignCustomer': def<OrderDto>()(z.strictObject({ ...order, customerId: id.nullable() }), 'session'),
  'orders.park': def<OrderDto>()(z.strictObject(order), 'session'),
  'orders.resume': def<OrderDto>()(z.strictObject(order), 'session'),
  'orders.addLine': def<OrderDto>()(
    z.strictObject({
      ...order,
      line: z.strictObject({
        productId: id,
        qtyMilli: int,
        modifierIds: z.array(id).max(50).optional(),
        note: text.optional(),
        menuChoices: z.array(z.strictObject({ courseId: id, productIds: z.array(id).max(20) })).max(20).optional()
      }),
      overrideTokenId: tokenId
    }),
    'session'
  ),
  'orders.setLineQty': def<OrderDto>()(z.strictObject({ ...line, qtyMilli: int, overrideTokenId: tokenId }), 'session'),
  /**
   * `overrideTokenId` covers the order's discount check; `voidOverrideTokenId` is a manager's approval of
   * voiding a line already sent to the kitchen (`order.void_sent`), for a user without that permission.
   */
  'orders.voidLine': def<OrderDto>()(
    z.strictObject({ ...line, reason: text, overrideTokenId: tokenId, voidOverrideTokenId: tokenId }),
    'session'
  ),
  'orders.setLineDiscount': def<OrderDto>()(
    z.strictObject({ ...line, discount: discount.nullable(), overrideTokenId: tokenId }),
    'session'
  ),
  'orders.setTicketDiscount': def<OrderDto>()(
    z.strictObject({ ...order, discount: discount.nullable(), overrideTokenId: tokenId }),
    'session'
  ),
  /** Offers a line or charges it again; `discountOverrideTokenId` covers the order's discount check. */
  'orders.setFree': def<OrderDto>()(
    z.strictObject({
      ...line,
      free: z.boolean(),
      reason: text,
      overrideTokenId: tokenId,
      discountOverrideTokenId: tokenId
    }),
    'session'
  ),
  'orders.sendToKitchen': def<OrderDto>()(z.strictObject(order), 'session'),
  'orders.sendNextCourse': def<OrderDto>()(z.strictObject(order), 'session'),
  'orders.transferTable': def<OrderDto>()(z.strictObject({ ...order, toTableId: id }), 'session'),
  'orders.mergeTables': def<OrderDto>()(
    z.strictObject({ fromOrderId: id, intoOrderId: id, overrideTokenId: tokenId }),
    'session'
  ),
  /** Returns the source order. */
  'orders.moveLines': def<OrderDto>()(
    z.strictObject({ fromOrderId: id, lineIds: z.array(id).max(500), toOrderId: id, overrideTokenId: tokenId }),
    'session'
  ),
  'orders.addPayment': def<OrderDto>()(z.strictObject({ ...order, payment }), 'session'),
  'orders.removePayment': def<OrderDto>()(
    z.strictObject({ ...order, paymentId: id, reason: text, overrideTokenId: tokenId }),
    'session'
  ),
  /** Closes a paid order into its ticket. */
  'orders.close': def<TicketDto>()(z.strictObject({ ...order, overrideTokenId: tokenId }), 'session'),
  /** Bill by items: one ticket per group. */
  'orders.splitAndClose': def<TicketDto[]>()(
    z.strictObject({
      ...order,
      groups: z.array(z.strictObject({ lineIds: z.array(id).max(500), payments: z.array(payment).max(20) })).max(50),
      overrideTokenId: tokenId
    }),
    'session'
  )
}
