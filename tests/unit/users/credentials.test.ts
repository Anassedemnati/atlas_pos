import { describe, expect, it } from 'vitest'
import { initialsOf, isValidPin, normalizeUsername } from '../../../src/main/domain/users/credentials'

describe('isValidPin', () => {
  it('accepts 4 to 6 ASCII digits', () => {
    for (const pin of ['1234', '12345', '123456', '0000']) expect(isValidPin(pin), pin).toBe(true)
  })

  it('refuses anything else', () => {
    for (const pin of ['', '123', '1234567', '12a4', ' 1234', '1234 ', '12.4', '١٢٣٤', '1234\n']) {
      expect(isValidPin(pin), JSON.stringify(pin)).toBe(false)
    }
  })
})

describe('normalizeUsername', () => {
  it('trims and lower-cases, so Amine and amine are one account', () => {
    expect(normalizeUsername('  Amine.Benali ')).toBe('amine.benali')
  })

  it('returns null for a name that is not a valid username', () => {
    for (const name of ['', '  ', 'ab', 'has space', 'a'.repeat(65), ' '.repeat(200) + 'amine', 'é-accent', 'semi;colon']) {
      expect(normalizeUsername(name), name).toBeNull()
    }
  })

  it('allows letters, digits and . _ - @, up to 64 characters', () => {
    expect(normalizeUsername('amine_b-2@atlas.ma')).toBe('amine_b-2@atlas.ma')
    expect(normalizeUsername('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('initialsOf', () => {
  it('takes the first letter of the first two words, upper-cased', () => {
    expect(initialsOf('Sara El Idrissi')).toBe('SE')
    expect(initialsOf('  amine   benali ')).toBe('AB')
  })

  it('takes one letter for a single word', () => {
    expect(initialsOf('Youssef')).toBe('Y')
  })

  it('works with Arabic names (code points, no case)', () => {
    expect(initialsOf('أمين بنعلي')).toBe('أب')
  })

  it('falls back to ? for an empty name', () => {
    expect(initialsOf('   ')).toBe('?')
  })
})
