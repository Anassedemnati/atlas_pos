import { describe, expect, it } from 'vitest'
import { isManagerPermissions, parsePermissions, ProfileInputSchema } from '../../../src/main/domain/users/profile'
import { PERMISSIONS } from '../../../src/shared/permissions'

describe('isManagerPermissions', () => {
  it('is true only for a profile holding every permission', () => {
    expect(isManagerPermissions([...PERMISSIONS])).toBe(true)
    expect(isManagerPermissions([...PERMISSIONS].reverse())).toBe(true)
    expect(isManagerPermissions(PERMISSIONS.slice(1))).toBe(false)
    expect(isManagerPermissions([])).toBe(false)
  })
})

describe('parsePermissions', () => {
  it('reads the stored list and drops what is not a known permission', () => {
    expect(parsePermissions('["order.discount","bogus","report.x"]')).toEqual(['order.discount', 'report.x'])
  })

  it('gives no permission for a row that is not a JSON list (fail closed)', () => {
    expect(parsePermissions('not json')).toEqual([])
    expect(parsePermissions('{"a":1}')).toEqual([])
  })
})

describe('ProfileInputSchema', () => {
  const ok = { name: { fr: 'Gérant' }, permissions: ['order.discount'], maxDiscountBp: 1000 }

  it('accepts a valid profile', () => {
    expect(ProfileInputSchema.safeParse(ok).success).toBe(true)
  })

  it('refuses a duplicate or unknown permission, a bad discount, a blank French name', () => {
    expect(ProfileInputSchema.safeParse({ ...ok, permissions: ['order.discount', 'order.discount'] }).success).toBe(false)
    expect(ProfileInputSchema.safeParse({ ...ok, permissions: ['teleport'] }).success).toBe(false)
    expect(ProfileInputSchema.safeParse({ ...ok, maxDiscountBp: 10001 }).success).toBe(false)
    expect(ProfileInputSchema.safeParse({ ...ok, maxDiscountBp: -1 }).success).toBe(false)
    expect(ProfileInputSchema.safeParse({ ...ok, maxDiscountBp: 10.5 }).success).toBe(false)
    expect(ProfileInputSchema.safeParse({ ...ok, name: { fr: '  ' } }).success).toBe(false)
  })
})
