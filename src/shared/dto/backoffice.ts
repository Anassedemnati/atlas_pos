import type { LocalizedName } from '../names'
import type { VatRow } from '../vat'
import type { BackupEntryDto, BackupStatusDto, PrinterDto, PrintJobDto } from './system'
import type { CategoryRouteDto } from './setup'
import type { ImportError, ImportRow } from './catalog'
import type { DayDto, ZData } from './tickets'

// What the LAN web back office's HTTP API returns beyond the IPC types (see `main/interfaces/http`).
// Imported by path (`@shared/dto/backoffice`), not through the dto index.

export type ReportGroup = 'day' | 'product' | 'category' | 'user' | 'payment'

export interface ReportRow {
  /** The product, category, user or day id, the payment method code. */
  key: string
  label: LocalizedName
  ticketsCount?: number
  /** Payments of the method (credit notes subtracted). */
  count?: number
  qtyMilli?: number
  grossCents?: number
  discountsCents?: number
  /** TTC, credit notes subtracted. */
  totalCents: number
  /** `group=day` only. */
  dayNumber?: number
  zNumber?: number | null
  openedAt?: string
  open?: boolean
}

export interface SalesReport {
  from: string
  to: string
  group: ReportGroup
  /** Business days of the period (the one still open included). */
  daysCount: number
  /** The period's own X: the same figures as a Z, summed over the days. */
  totals: {
    ticketsCount: number
    creditsCount: number
    grossCents: number
    discountsCents: number
    totalCents: number
    byPayment: ZData['byPayment']
    byVat: VatRow[]
  }
  rows: ReportRow[]
}

export interface ZListItem {
  id: string
  dayId: string
  number: number
  dayNumber: number
  openedAt: string
  closedAt: string | null
  createdAt: string
  userId: string
  ticketsCount: number
  creditsCount: number
  grossCents: number
  discountsCents: number
  totalCents: number
}

export interface JournalLine {
  id: number
  at: string
  type: string
  entity: string
  entityId: string | null
  userId: string | null
  /** The display name of `userId` when that user still exists. */
  userName: string | null
  data: unknown
}

export interface Journal {
  lines: JournalLine[]
  /** Every event type found in the log, for the filter. */
  types: string[]
}

export interface ErrorLineDto {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  data: Record<string, unknown>
}

export interface DashboardDto {
  /** The open business day, null between a Z and the next sale. */
  day: DayDto | null
  /** The day so far (the X report); null with no open day or without the `report.x` permission. */
  today: ZData | null
  backup: BackupStatusDto | null
  printers: PrinterDto[]
  /** Print jobs that failed or whose outcome is uncertain. */
  jobs: PrintJobDto[]
  version: string
}

/** A backup as the browser sees it: an id from the listing instead of a path on the machine. */
export type BackupItemDto = Omit<BackupEntryDto, 'file'> & { id: string }

export interface BackupsDto {
  status: BackupStatusDto
  entries: BackupItemDto[]
}

export interface ImportPreviewDto {
  previewId: string
  rows: ImportRow[]
  errors: ImportError[]
}

export interface SettingsDto {
  values: Record<string, unknown>
  /** Settings only the technician may change: shown, not editable here. */
  technicianOnly: string[]
}

export interface PrintersDto {
  printers: PrinterDto[]
  routing: CategoryRouteDto[]
  jobs: PrintJobDto[]
}

export interface SessionInfoDto {
  csrfToken: string
  user: import('./system').SessionDto
}
