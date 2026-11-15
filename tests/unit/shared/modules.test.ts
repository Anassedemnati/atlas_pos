import { describe, expect, it } from 'vitest'
import { MODULES, type ModuleKey } from '@shared/modules'

describe('MODULES', () => {
  it('lists every optional module of the contract, in order', () => {
    expect([...MODULES]).toEqual(['tables', 'kitchen', 'menus', 'customers', 'stock', 'barcode', 'scale'])
  })

  it('derives the ModuleKey type from the list', () => {
    const m: ModuleKey = 'scale'
    expect(MODULES).toContain(m)
  })
})
