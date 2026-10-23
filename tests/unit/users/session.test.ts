import { describe, expect, it } from 'vitest'
import { AppErrorException } from '../../../src/main/application/errors'
import { hasPermission, holdsAll, holdsProfile, requirePermission } from '../../../src/main/domain/users/session'
import { CASHIER_PERMISSIONS, sessionOf } from '../../helpers/users'

describe('hasPermission / requirePermission', () => {
  const cashier = sessionOf('u1', CASHIER_PERMISSIONS, 1000)

  it('hasPermission reports whether the session holds the permission', () => {
    expect(hasPermission(cashier, 'order.discount')).toBe(true)
    expect(hasPermission(cashier, 'users.manage')).toBe(false)
  })

  it('holdsAll is true only when every listed permission is held (an empty list is held)', () => {
    expect(holdsAll(cashier, ['order.discount', 'report.x'])).toBe(true)
    expect(holdsAll(cashier, ['order.discount', 'users.manage'])).toBe(false)
    expect(holdsAll(cashier, [])).toBe(true)
  })

  it('holdsProfile needs every permission and a discount limit no higher than the session, unless it may override', () => {
    const profile = (maxDiscountBp: number, ...permissions: Parameters<typeof holdsAll>[1]) => ({ permissions, maxDiscountBp })
    expect(holdsProfile(cashier, profile(1000, 'order.discount'))).toBe(true)
    expect(holdsProfile(cashier, profile(1001, 'order.discount'))).toBe(false)
    expect(holdsProfile(cashier, profile(0, 'users.manage'))).toBe(false)
    const lead = sessionOf('u2', ['order.discount', 'order.discount.override'], 0)
    expect(holdsProfile(lead, profile(10000, 'order.discount'))).toBe(true)
    expect(holdsProfile(lead, profile(10000, 'users.manage'))).toBe(false)
  })

  it('requirePermission passes silently when the permission is held', () => {
    expect(() => requirePermission(cashier, 'report.x')).not.toThrow()
  })

  it('requirePermission throws AppError forbidden naming the missing permission', () => {
    let thrown: unknown
    try {
      requirePermission(cashier, 'users.manage')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppErrorException)
    expect(thrown).toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.forbidden',
      params: { permission: 'users.manage' }
    })
  })
})
