import type { CategoryRouteDto, FloorDto, PaymentMethodDto, StaffDto } from '../dto'
import { def, none, type ChannelAuth } from './define'

const usersManager: ChannelAuth = { permission: 'users.manage', orTechnician: true }

/** Read-only lists of what the setup created: the floor plan, payment methods, printer routing, staff. */
export const configChannels = {
  'floor.list': def<FloorDto>()(none, 'staff'),
  'payments.list': def<PaymentMethodDto[]>()(none, 'staff'),
  /** For every category, the printers that print its lines. */
  'printing.routing': def<CategoryRouteDto[]>()(none, 'staff'),
  /** Users (no PIN or password hashes) and permission profiles. */
  'users.list': def<StaffDto>()(none, usersManager)
}
