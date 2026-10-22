import { describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  it('returns a UUIDv7 string', () => {
    expect(newId()).toMatch(UUID_V7)
  })

  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()))
    expect(ids.size).toBe(1000)
  })

  it('returns ids that sort in creation order', () => {
    const ids = Array.from({ length: 1000 }, () => newId())
    expect([...ids].sort()).toEqual(ids)
  })
})
