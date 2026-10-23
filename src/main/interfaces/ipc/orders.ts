import type { ordersChannels } from '@shared/ipc/orders'
import { overrideToken as token, type Handlers } from './context'

/** Orders at the till: lines, discounts, kitchen, tables, payments, closing. */
export const ordersHandlers: Handlers<keyof typeof ordersChannels> = {
  'orders.open': (input, ctx) => ctx.services().orders.openOrder(ctx.session(), input),
  'orders.get': ({ orderId }, ctx) => ctx.services().orders.getOrder(ctx.session(), orderId),
  'orders.setNote': ({ orderId, note, lineId }, ctx) => ctx.services().orders.setNote(ctx.session(), orderId, note, lineId),
  'orders.setCovers': ({ orderId, covers }, ctx) => ctx.services().orders.setCovers(ctx.session(), orderId, covers),
  'orders.assignCustomer': ({ orderId, customerId }, ctx) =>
    ctx.services().orders.assignCustomer(ctx.session(), orderId, customerId),
  'orders.park': ({ orderId }, ctx) => ctx.services().orders.parkOrder(ctx.session(), orderId),
  'orders.resume': ({ orderId }, ctx) => ctx.services().orders.resumeOrder(ctx.session(), orderId),
  'orders.addLine': ({ orderId, line, overrideTokenId }, ctx) =>
    ctx.services().orders.addLine(ctx.session(), orderId, line, token(overrideTokenId)),
  'orders.setLineQty': ({ orderId, lineId, qtyMilli, overrideTokenId }, ctx) =>
    ctx.services().orders.setLineQty(ctx.session(), orderId, lineId, qtyMilli, token(overrideTokenId)),
  'orders.voidLine': ({ orderId, lineId, reason, overrideTokenId }, ctx) =>
    ctx.services().orders.voidLine(ctx.session(), orderId, lineId, reason, token(overrideTokenId)),
  'orders.setLineDiscount': ({ orderId, lineId, discount, overrideTokenId }, ctx) =>
    ctx.services().orders.setLineDiscount(ctx.session(), orderId, lineId, discount, token(overrideTokenId)),
  'orders.setTicketDiscount': ({ orderId, discount, overrideTokenId }, ctx) =>
    ctx.services().orders.setTicketDiscount(ctx.session(), orderId, discount, token(overrideTokenId)),
  'orders.setFree': ({ orderId, lineId, free, reason, overrideTokenId, discountOverrideTokenId }, ctx) =>
    ctx
      .services()
      .orders.setFree(ctx.session(), orderId, lineId, free, reason, token(overrideTokenId), token(discountOverrideTokenId)),
  'orders.sendToKitchen': ({ orderId }, ctx) => ctx.services().orders.sendToKitchen(ctx.session(), orderId),
  'orders.sendNextCourse': ({ orderId }, ctx) => ctx.services().orders.sendNextCourse(ctx.session(), orderId),
  'orders.transferTable': ({ orderId, toTableId }, ctx) =>
    ctx.services().orders.transferTable(ctx.session(), orderId, toTableId),
  'orders.mergeTables': ({ fromOrderId, intoOrderId, overrideTokenId }, ctx) =>
    ctx.services().orders.mergeTables(ctx.session(), fromOrderId, intoOrderId, token(overrideTokenId)),
  'orders.moveLines': ({ fromOrderId, lineIds, toOrderId, overrideTokenId }, ctx) =>
    ctx.services().orders.moveLines(ctx.session(), fromOrderId, lineIds, toOrderId, token(overrideTokenId)),
  'orders.addPayment': ({ orderId, payment }, ctx) => ctx.services().orders.addPayment(ctx.session(), orderId, payment),
  'orders.removePayment': ({ orderId, paymentId, reason, overrideTokenId }, ctx) =>
    ctx.services().orders.removePayment(ctx.session(), orderId, paymentId, reason, token(overrideTokenId)),
  'orders.close': ({ orderId, overrideTokenId }, ctx) =>
    ctx.services().tickets.closeOrder(ctx.session(), orderId, token(overrideTokenId)),
  'orders.splitAndClose': ({ orderId, groups, overrideTokenId }, ctx) =>
    ctx.services().tickets.splitAndClose(ctx.session(), orderId, groups, token(overrideTokenId))
}
