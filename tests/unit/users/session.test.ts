import { describe, expect, it } from 'vitest'
import { AppErrorException } from '../../../src/main/application/errors'
import { hasPermission, requirePermission } from '../../../src/main/domain/users/session'
import { CASHIER_PERMISSIONS, sessionOf } from '../../helpers/users'

describe('hasPermission / requirePermission', () => {
  const cashier = sessionOf('u1', CASHIER_PERMISSIONS, 1000)

  it('hasPermission reports whether the session holds the permission', () => {
    expect(hasPermission(cashier, 'order.discount')).toBe(true)
    expect(hasPermission(cashier, 'users.manage')).toBe(false)
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
