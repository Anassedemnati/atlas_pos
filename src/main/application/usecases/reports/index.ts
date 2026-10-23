import type { Database } from '../../../infrastructure/db/connection'
import { createJournalUseCases, type JournalUseCases } from './journal'
import { createReportsUseCases, type ReportsUseCases } from './sales'

export { exportReport, reportFileName, reportTable, type ReportFormat } from './export'
export type { Journal, JournalLine, JournalQuery } from './journal'
export { REPORT_GROUPS, type ReportGroup, type ReportRow, type SalesReport, type ZListItem } from './sales'

export type ReportsService = ReportsUseCases & JournalUseCases

/** The read side of the back office: takings over a period, the Z history, the event log. No writes. */
export function createReportsService(deps: { db: Database }): ReportsService {
  return { ...createReportsUseCases(deps), ...createJournalUseCases(deps) }
}
