import { salesContext, type SalesDeps } from '../orders/context'
import { createCancelUseCases, type CancelUseCases } from './cancel'
import { createCloseUseCases, type CloseUseCases } from './close'

export type { SplitGroup } from './close'

export type TicketsService = CloseUseCases & CancelUseCases

/**
 * Tickets: closing an order into its immutable ticket (gap-free numbers allocated in the closing
 * transaction), bill splitting, credit notes and duplicates. A closed ticket never changes.
 */
export function createTicketsService(deps: SalesDeps): TicketsService {
  const ctx = salesContext(deps)
  return { ...createCloseUseCases(ctx), ...createCancelUseCases(ctx) }
}
