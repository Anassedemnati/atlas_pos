import { describe, expect, it } from 'vitest'
import { pickName, type LocalizedName } from '@shared/names'

describe('pickName', () => {
  const full: LocalizedName = { fr: 'Thé', ar: 'شاي', en: 'Tea' }

  it('returns the name in the requested language', () => {
    expect(pickName(full, 'fr')).toBe('Thé')
    expect(pickName(full, 'ar')).toBe('شاي')
    expect(pickName(full, 'en')).toBe('Tea')
  })

  it('falls back to French when the translation is missing', () => {
    expect(pickName({ fr: 'Thé' }, 'ar')).toBe('Thé')
    expect(pickName({ fr: 'Thé', ar: 'شاي' }, 'en')).toBe('Thé')
  })

  it('falls back to French when the translation is empty', () => {
    expect(pickName({ fr: 'Thé', en: '' }, 'en')).toBe('Thé')
  })
})
