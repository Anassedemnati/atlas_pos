import { describe, expect, it } from 'vitest'
import { PERMISSIONS, type Permission } from '@shared/permissions'

describe('PERMISSIONS', () => {
  it('lists every permission of the contract, in order', () => {
    expect([...PERMISSIONS]).toEqual([
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
    ])
  })

  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
  })

  it('derives the Permission type from the list', () => {
    const p: Permission = 'drawer.open'
    expect(PERMISSIONS).toContain(p)
  })
})
