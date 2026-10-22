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
