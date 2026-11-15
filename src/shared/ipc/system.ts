import { z } from 'zod'
import type { BackupEntryDto, BackupRunDto, BackupStatusDto, HardwareDto, PrinterDto, PrintJobDto } from '../dto'
import { def, id, none, type ChannelAuth } from './define'

/** Acting on the printers and backups: a manager (`settings.manage`) or the technician. */
const manager: ChannelAuth = { permission: 'settings.manage', orTechnician: true }

/**
 * Settings. `settings.set` checks the setting's own rule (a permission, or the technician mode);
 * the technician code is never read or written here.
 */
export const settingsChannels = {
  'settings.getAll': def<Record<string, unknown>>()(none, 'staff'),
  'settings.set': def<true>()(z.strictObject({ key: z.string().min(1).max(64), value: z.unknown() }), 'handler')
}

/**
 * Backups. Listing and restoring need no sign-in only while the database is corrupt (there is no user
 * to sign in); otherwise `backup.restore` needs `backup.restore` or the technician mode.
 */
export const backupChannels = {
  'backup.status': def<BackupStatusDto>()(none, 'staff'),
  /** The backups of the configured destinations and of the data directory, or of a folder from `system.pickFolder`. */
  'backup.list': def<BackupEntryDto[]>()(z.strictObject({ folder: z.string().max(4096).optional() }), 'handler'),
  /** A manual full backup now. */
  'backup.run': def<BackupRunDto>()(none, manager),
  /**
   * Replaces the database with a backup listed by `backup.list` (with the same `folder`), then restarts
   * the services and reloads the till window on its route (everyone is signed out).
   */
  'backup.restore': def<{ route: string }>()(
    z.strictObject({ file: z.string().min(1).max(4096), folder: z.string().max(4096).optional() }),
    'handler'
  )
}

/** Printers, the print queue, the hardware. */
export const printingChannels = {
  'printing.printers': def<PrinterDto[]>()(none, 'staff'),
  /** Jobs needing attention (failed, uncertain). */
  'printing.jobs': def<PrintJobDto[]>()(none, 'staff'),
  'printing.reprintJob': def<PrintJobDto>()(z.strictObject({ jobId: id }), manager),
  'printing.dismissJob': def<PrintJobDto>()(z.strictObject({ jobId: id }), manager),
  'hardware.detect': def<HardwareDto>()(none, 'technician'),
  /** Prints the test page now, outside the queue. */
  'hardware.testPrinter': def<null>()(z.strictObject({ printerId: id }), manager),
  /** Opens the cash drawer of the receipt printer. */
  'hardware.openDrawer': def<true>()(none, { permission: 'drawer.open' })
}
