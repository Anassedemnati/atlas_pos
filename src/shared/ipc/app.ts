import { z } from 'zod'
import type { AppStatusDto } from '../dto'
import { def, id, none } from './define'

/** The shell: start-up report, leaving the kiosk, file dialogs, the customer display. */
export const appChannels = {
  /** How this run started and which route the till window was opened on. */
  'app.startupReport': def<AppStatusDto>()(none, 'public'),
  /**
   * Closes the application (the watchdog does not restart it). The technician mode, or no database open
   * (a till stuck on the setup or recovery screen must not trap the person in front of it).
   */
  'app.quitToDesktop': def<true>()(none, 'handler'),
  /**
   * Leaves safe mode: the application quits and the watchdog starts it normally. A signed-in user or the
   * technician mode, or no database open; refused (`not_in_safe_mode`) outside safe mode.
   */
  'app.restartNormally': def<true>()(none, 'handler'),
  /**
   * A folder chosen in the system dialog, or null when cancelled; the path is then usable by `backup.list`.
   * The dialogs need a signed-in user or the technician mode, except while no database is open (setup, recovery).
   */
  'system.pickFolder': def<string | null>()(z.strictObject({ title: z.string().max(200).optional() }), 'handler'),
  /** A file chosen in the system dialog, or null when cancelled. Same rule as `system.pickFolder`. */
  'system.pickFile': def<string | null>()(
    z.strictObject({
      title: z.string().max(200).optional(),
      extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(20).optional()
    }),
    'handler'
  ),
  /** Shows the order on the customer display (null: the idle screen). Does nothing without a display. */
  'display.update': def<true>()(z.strictObject({ orderId: id.nullable() }), 'session')
}
