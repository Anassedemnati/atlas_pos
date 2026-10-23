import type { CategoryRouteDto, FloorDto, PaymentMethodDto, StaffDto } from '../dto'
import { z } from 'zod'
import { def, id, int, localizedName, none, type ChannelAuth } from './define'

const usersManager: ChannelAuth = { permission: 'users.manage', orTechnician: true }

/** Read-only lists of what the setup created: the floor plan, payment methods, printer routing, staff. */
export const configChannels = {
  'floor.list': def<FloorDto>()(none, 'staff'),
  /**
   * Replaces the floor plan (rooms in order, tables with their place and size). A manager (`settings.manage`).
   * An id the database does not know is a new room or table; an active table left out is removed (`table_in_use`
   * while it has an open order). Returns the plan as saved.
   */
  'floor.save': def<FloorDto>()(
    z.strictObject({
      rooms: z.array(z.strictObject({ id, name: localizedName })).max(50),
      tables: z
        .array(
          z.strictObject({
            id,
            roomId: id,
            label: z.string().max(200),
            shape: z.enum(['square', 'round', 'rect']),
            x: int,
            y: int,
            w: int,
            h: int,
            seats: int
          })
        )
        .max(500)
    }),
    { permission: 'settings.manage' }
  ),
  'payments.list': def<PaymentMethodDto[]>()(none, 'staff'),
  /** For every category, the printers that print its lines. */
  'printing.routing': def<CategoryRouteDto[]>()(none, 'staff'),
  /** Users (no PIN or password hashes) and permission profiles. */
  'users.list': def<StaffDto>()(none, usersManager)
}
