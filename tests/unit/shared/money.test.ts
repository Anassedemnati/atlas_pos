import { describe, expect, it } from 'vitest'
import { formatMoney, parseMoney } from '@shared/money'

describe('formatMoney', () => {
  it('formats French with a narrow no-break space as thousands separator', () => {
    expect(formatMoney(245000, 'fr')).toBe('2 450,00 DH')
  })

  it('formats small amounts without a separator', () => {
    expect(formatMoney(3800, 'fr')).toBe('38,00 DH')
    expect(formatMoney(5, 'fr')).toBe('0,05 DH')
    expect(formatMoney(0, 'fr')).toBe('0,00 DH')
  })

  it('formats English like French', () => {
    expect(formatMoney(245000, 'en')).toBe('2 450,00 DH')
  })

  it('formats Arabic with the dirham word and the same separators', () => {
    expect(formatMoney(27100, 'ar')).toBe('271,00 درهم')
    expect(formatMoney(245000, 'ar')).toBe('2 450,00 درهم')
  })

  it('groups every three digits', () => {
    expect(formatMoney(123456789, 'fr')).toBe('1 234 567,89 DH')
    expect(formatMoney(100000000, 'fr')).toBe('1 000 000,00 DH')
  })

  it('formats negative amounts with a leading minus', () => {
    expect(formatMoney(-245050, 'fr')).toBe('-2 450,50 DH')
  })
})

describe('parseMoney', () => {
  it('parses whole numbers', () => {
    expect(parseMoney('38')).toBe(3800)
    expect(parseMoney('0')).toBe(0)
  })

  it('parses a comma or a dot as the decimal mark', () => {
    expect(parseMoney('38,5')).toBe(3850)
    expect(parseMoney('38.50')).toBe(3850)
    expect(parseMoney('0,05')).toBe(5)
  })

  it('ignores spaces used as thousands separators', () => {
    expect(parseMoney('1 200,00')).toBe(120000)
    expect(parseMoney('2 450,00')).toBe(245000)
    expect(parseMoney('2 450')).toBe(245000)
    expect(parseMoney('  38  ')).toBe(3800)
  })

  it('is exact for values that binary floats get wrong', () => {
    expect(parseMoney('1.15')).toBe(115)
    expect(parseMoney('4.35')).toBe(435)
  })

  it('round-trips with formatMoney', () => {
    for (const cents of [0, 5, 3800, 245000, 123456789]) {
      expect(parseMoney(formatMoney(cents, 'fr').replace(' DH', ''))).toBe(cents)
    }
  })

  it('rejects invalid input', () => {
    for (const bad of ['', '   ', 'abc', '12abc', '1,2,3', '1.234', '-5', '1e3', '38 DH', ',', '.']) {
      expect(parseMoney(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('rejects amounts beyond the safe integer range', () => {
    expect(parseMoney('99999999999999999999')).toBeNull()
  })
})
