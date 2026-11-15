import { salesContext, type SalesDeps } from '../orders/context'
import { createDayUseCases, type DayUseCases } from './reports'

export type DaysService = DayUseCases

/**
 * Business days (from the first sale after a Z to the next Z), the cut-over gate, X and Z reports.
 */
export function createDaysService(deps: SalesDeps): DaysService {
  return createDayUseCases(salesContext(deps))
}
