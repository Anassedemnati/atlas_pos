/**
 * Every permission of the app. Adding one needs a migration that grants it to the profiles that
 * already hold all the others: a manager is "a profile with every permission", so without that
 * migration no existing profile is a manager any more and every `saveUser` / `saveProfile` is
 * refused with `last_manager` (the install is wedged until someone edits the database).
 */
export const PERMISSIONS = [
  'order.discount',
  'order.discount.override',
  'order.void_sent',
  'order.free_item',
  'ticket.cancel',
  'ticket.reprint',
  'drawer.open',
  'day.close',
  'report.x',
  'invoice.create',
  'catalog.manage',
  'users.manage',
  'settings.manage',
  'backup.restore',
  'backoffice.login'
] as const

export type Permission = (typeof PERMISSIONS)[number]
