import { salesContext, type SalesDeps } from './context'
import { createDiscountUseCases, type DiscountUseCases } from './discounts'
import { createKitchenUseCases, type KitchenUseCases } from './kitchen'
import { createLineUseCases, type LineUseCases } from './lines'
import { createOpenUseCases, type OpenUseCases } from './open'
import { createPaymentUseCases, type PaymentUseCases } from './payments'
import { createTableUseCases, type TableUseCases } from './tables'

export type { SalesDeps } from './context'
export type { AddLineInput, AddPaymentInput, OpenOrderInput } from './inputs'

export type OrdersService = OpenUseCases & LineUseCases & DiscountUseCases & KitchenUseCases & TableUseCases & PaymentUseCases

/**
 * Orders at the till: open, lines, discounts, kitchen, tables, payments. Every change is one transaction,
 * written at once (a power cut loses at most the tap in progress), logged in the event log and announced
 * with `order.changed` once committed. Refusals are `Result` errors; a missing permission is `forbidden`.
 */
export function createOrdersService(deps: SalesDeps): OrdersService {
  const ctx = salesContext(deps)
  return {
    ...createOpenUseCases(ctx),
    ...createLineUseCases(ctx),
    ...createDiscountUseCases(ctx),
    ...createKitchenUseCases(ctx),
    ...createTableUseCases(ctx),
    ...createPaymentUseCases(ctx)
  }
}
