import type { Lang } from '../names'
import type { Permission } from '../permissions'
import type { OrderDto, OrderType } from './orders'

// The application shell: who is signed in, how the start went, backups, printers, hardware.
// Mirrors of main-process types the renderer must not import (they pull in Node); the main process
// checks at compile time that its own types still fit these.

/** The signed-in user as the renderer sees it. The session itself stays in the main process. */
export interface SessionDto {
  userId: string
  displayName: string
  lang: Lang
  permissions: Permission[]
  /** Basis points (1000 = 10 %). */
  maxDiscountBp: number
  /** The technician code was entered in this window. */
  isTechnician: boolean
}

export interface TillUserDto {
  id: string
  displayName: string
  initials: string
}

/** A manager's one-time approval. The renderer hands back `id` only (`overrideTokenId`). */
export interface OverrideTokenDto {
  id: string
  permission: Permission
  expiresAt: string
}

export type StartupState = 'needs-setup' | 'ok' | 'recovered' | 'corrupt' | 'newer-schema'

/** The renderer composes the text: table label, else "n° <orderNumber>", else a generic name plus `idSuffix`. */
export interface RestoredOrderDto {
  id: string
  type: OrderType
  tableLabel: string | null
  orderNumber: number | null
  idSuffix: string
}

export interface StartupReportDto {
  state: StartupState
  unclean: boolean
  integrity: 'ok' | 'failed'
  restoredOrders: RestoredOrderDto[]
  lastBackupAt: string | null
  corruptFile: string | null
  newerSchema: { found: number; supported: number } | null
}

/** `app.startupReport`: how this run started and where the till window was sent. */
export interface AppStatusDto {
  /** Null when the start-up check itself failed (`startupError`). */
  report: StartupReportDto | null
  /** Why the start-up check could not run (I/O, permissions): the till shows the recovery screen. */
  startupError: string | null
  /** The hash route the till window was opened on, e.g. `#/login`. */
  route: string
  /** Started by the watchdog after 3 crashes in 5 minutes. */
  safeMode: boolean
  /** The database is open and the use cases are available. */
  ready: boolean
  version: string
}

export type BackupState = 'ok' | 'pending' | 'warning' | 'error'

export interface BackupStatusDto {
  lastOkAt: string | null
  lastError: string | null
  perTarget: { id: string; role: 'disk' | 'usb' | 'nas'; lastOkAt: string | null; lastError: string | null; state: BackupState }[]
  overall: 'ok' | 'warning' | 'error'
}

export interface BackupEntryDto {
  /** The destination id, or `local` (the data directory), or `picked` (a folder chosen by hand). */
  source: string
  role: 'disk' | 'usb' | 'nas' | 'local'
  /** Absolute path of the `.atlasbak`: what `backup.restore` takes. */
  file: string
  fileName: string
  createdAt: string
  kind: 'live' | 'full' | 'pre-change' | 'manual'
  schemaVersion: number
  appVersion: string
}

export interface BackupRunDto {
  runId: string
  at: string
  fileName: string
  results: { targetId: string; role: 'disk' | 'usb' | 'nas'; ok: boolean; error?: string }[]
}

export type PrintStatus = 'pending' | 'printing' | 'done' | 'failed' | 'uncertain'

export interface PrintJobDto {
  id: string
  printerId: string
  printerName: string | null
  kind: 'receipt' | 'kitchen' | 'kitchen-cancel' | 'drawer' | 'z' | 'prebill' | 'invoice'
  status: PrintStatus
  attempts: number
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface PrinterDto {
  id: string
  name: string
  kind: string
  address: string
  widthMm: number
  lang: Lang
  raster: boolean
  role: string
  active: boolean
}

export interface HardwareDto {
  osPrinters: { name: string; isDefault: boolean }[]
  serialPorts: { path: string; manufacturer: string | null }[]
  deviceFiles: string[]
  displays: { id: number; bounds: { x: number; y: number; width: number; height: number } }[]
}

/** What the customer display shows: the current order, or the idle screen (null). */
export interface DisplayOrderDto {
  order: OrderDto | null
}
