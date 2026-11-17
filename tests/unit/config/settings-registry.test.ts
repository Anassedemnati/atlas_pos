import { describe, expect, it } from 'vitest'
import { MODULES } from '@shared/modules'
import { PERMISSIONS } from '@shared/permissions'
import {
  PORTABLE_SETTING_KEYS,
  SETTINGS,
  SETTING_KEYS,
  defaultOf,
  portableSettingsSchema
} from '../../../src/main/domain/config/settings-registry'

const validLegal = {
  raisonSociale: 'Café Atlas SARL',
  nomCommercial: 'Café Atlas',
  adresse: '12 avenue Hassan II',
  ville: 'Casablanca',
  telephone: '0522000000',
  ice: '001234567000012',
  if: '12345678',
  rc: '123456',
  patente: '31234567'
}

describe('SETTINGS registry', () => {
  it('declares exactly the keys of the contract', () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      [
        'autostart.enabled',
        'backoffice.enabled',
        'backoffice.port',
        'backup.continuous',
        'backup.onClose',
        'backup.retentionDays',
        'backup.warnAfterHours',
        'business.legal',
        'business.logo',
        'business.type',
        'cancel.reasons',
        'day.cutoverHour',
        'discount.reasons',
        'display.customerEnabled',
        'kiosk.enabled',
        'modules',
        'receipt.footer',
        'receipt.header',
        'receipt.lang',
        'tech.codeHash',
        'till.autoLockSeconds',
        'ui.defaultLang',
        'ui.keyStyle',
        'ui.ticketSide',
        'vat.rates'
      ].sort()
    )
  })

  it('has the contract defaults', () => {
    expect(defaultOf('vat.rates')).toEqual([2000, 1400, 1000, 700, 0])
    expect(defaultOf('receipt.footer')).toBe('Merci de votre visite !')
    expect(defaultOf('ui.ticketSide')).toBe('start')
    expect(defaultOf('ui.keyStyle')).toBe('color')
    expect(defaultOf('till.autoLockSeconds')).toBe(120)
    expect(defaultOf('day.cutoverHour')).toBe(5)
    expect(defaultOf('kiosk.enabled')).toBe(true)
    expect(defaultOf('autostart.enabled')).toBe(true)
    expect(defaultOf('display.customerEnabled')).toBe(false)
    expect(defaultOf('backoffice.enabled')).toBe(true)
    expect(defaultOf('backoffice.port')).toBe(8080)
    expect(defaultOf('backup.continuous')).toBe(true)
    expect(defaultOf('backup.onClose')).toBe(true)
    expect(defaultOf('backup.retentionDays')).toBe(30)
    expect(defaultOf('backup.warnAfterHours')).toBe(24)
    expect(defaultOf('discount.reasons')).toEqual(['Client fidèle', 'Geste commercial', 'Erreur de commande'])
    expect(defaultOf('cancel.reasons')).toEqual(['Erreur de saisie', 'Client parti', 'Produit indisponible'])
    expect(defaultOf('business.logo')).toBeNull()
    expect(defaultOf('tech.codeHash')).toBeNull()
  })

  it('has a default that satisfies its own schema, except the blank legal form', () => {
    for (const key of SETTING_KEYS) {
      if (key === 'business.legal') continue
      expect(SETTINGS[key].schema.safeParse(SETTINGS[key].default).success, key).toBe(true)
    }
    // Legal identity has no sensible default: the blank form must not pass for a real one.
    expect(SETTINGS['business.legal'].schema.safeParse(defaultOf('business.legal')).success).toBe(false)
  })

  it('gives every setting a valid scope and permission', () => {
    for (const key of SETTING_KEYS) {
      expect(['installation', 'user'], key).toContain(SETTINGS[key].scope)
      expect([...PERMISSIONS, 'technician'], key).toContain(SETTINGS[key].permission)
    }
    expect(SETTINGS['tech.codeHash'].permission).toBe('technician')
  })

  it('hands out a fresh copy of mutable defaults', () => {
    const rates = defaultOf('vat.rates')
    rates.push(1)
    expect(defaultOf('vat.rates')).toEqual([2000, 1400, 1000, 700, 0])
  })

  describe('business.legal', () => {
    const schema = SETTINGS['business.legal'].schema

    it('accepts a complete identity', () => {
      expect(schema.safeParse(validLegal).success).toBe(true)
    })

    it('rejects an ICE of 14 digits', () => {
      expect(schema.safeParse({ ...validLegal, ice: '00123456700001' }).success).toBe(false)
    })

    it('rejects an ICE of 16 digits or with letters', () => {
      expect(schema.safeParse({ ...validLegal, ice: '0012345670000123' }).success).toBe(false)
      expect(schema.safeParse({ ...validLegal, ice: '00123456700001A' }).success).toBe(false)
    })

    it('ignores spaces around the ICE', () => {
      expect(schema.parse({ ...validLegal, ice: ' 001234567000012 ' }).ice).toBe('001234567000012')
    })

    it('requires the trade name', () => {
      expect(schema.safeParse({ ...validLegal, nomCommercial: '' }).success).toBe(false)
      expect(schema.safeParse({ ...validLegal, nomCommercial: '   ' }).success).toBe(false)
      const { nomCommercial: _omitted, ...rest } = validLegal
      expect(schema.safeParse(rest).success).toBe(false)
    })

    it('accepts a café with only its trade name (no company: no raison sociale, ICE, IF, RC or patente)', () => {
      const blank = Object.fromEntries(Object.keys(validLegal).map((key) => [key, '']))
      expect(schema.parse({ ...blank, nomCommercial: 'Café Atlas' })).toMatchObject({ nomCommercial: 'Café Atlas', ice: '', patente: '' })
      expect(schema.safeParse({ ...blank, nomCommercial: 'Café Atlas', patente: '31234567' }).success).toBe(true)
    })

    it.each(Object.keys(validLegal).filter((key) => key !== 'nomCommercial'))('lets %s be empty, never missing', (field) => {
      expect(schema.parse({ ...validLegal, [field]: '   ' })[field as keyof typeof validLegal]).toBe('')
      const { [field]: _omitted, ...rest } = validLegal as Record<string, string>
      expect(schema.safeParse(rest).success).toBe(false)
    })
  })

  describe('value schemas', () => {
    it('modules needs a boolean for every module', () => {
      const schema = SETTINGS.modules.schema
      const all = Object.fromEntries(MODULES.map((m) => [m, false]))
      expect(schema.safeParse(all).success).toBe(true)
      expect(schema.safeParse({ ...all, tables: undefined }).success).toBe(false)
      expect(schema.safeParse({ ...all, unknown: true }).success).toBe(false)
      expect(Object.keys(defaultOf('modules')).sort()).toEqual([...MODULES].sort())
    })

    it('restricts the enumerations', () => {
      expect(SETTINGS['business.type'].schema.safeParse('bakery').success).toBe(true)
      expect(SETTINGS['business.type'].schema.safeParse('garage').success).toBe(false)
      expect(SETTINGS['receipt.lang'].schema.safeParse('ar').success).toBe(true)
      expect(SETTINGS['receipt.lang'].schema.safeParse('es').success).toBe(false)
      expect(SETTINGS['ui.defaultLang'].schema.safeParse('en').success).toBe(true)
      expect(SETTINGS['ui.ticketSide'].schema.safeParse('end').success).toBe(true)
      expect(SETTINGS['ui.ticketSide'].schema.safeParse('left').success).toBe(false)
      expect(SETTINGS['ui.keyStyle'].schema.safeParse('photo').success).toBe(true)
      expect(SETTINGS['ui.keyStyle'].schema.safeParse('icon').success).toBe(false)
    })

    it('bounds the numbers', () => {
      expect(SETTINGS['day.cutoverHour'].schema.safeParse(23).success).toBe(true)
      expect(SETTINGS['day.cutoverHour'].schema.safeParse(24).success).toBe(false)
      expect(SETTINGS['day.cutoverHour'].schema.safeParse(-1).success).toBe(false)
      expect(SETTINGS['backoffice.port'].schema.safeParse(8081).success).toBe(true)
      expect(SETTINGS['backoffice.port'].schema.safeParse(70000).success).toBe(false)
      expect(SETTINGS['backoffice.port'].schema.safeParse(80.5).success).toBe(false)
      expect(SETTINGS['till.autoLockSeconds'].schema.safeParse(0).success).toBe(false)
      expect(SETTINGS['backup.retentionDays'].schema.safeParse(0).success).toBe(false)
    })

    it('vat.rates is a non-empty list of basis points', () => {
      const schema = SETTINGS['vat.rates'].schema
      expect(schema.safeParse([2000, 1000]).success).toBe(true)
      expect(schema.safeParse([]).success).toBe(false)
      expect(schema.safeParse([20]).success).toBe(true) // basis points are free: 0.20 % is a rate
      expect(schema.safeParse([-1]).success).toBe(false)
      expect(schema.safeParse([10.5]).success).toBe(false)
    })

    it('reason lists hold non-blank text', () => {
      expect(SETTINGS['discount.reasons'].schema.safeParse(['Client fidèle']).success).toBe(true)
      expect(SETTINGS['discount.reasons'].schema.safeParse(['  ']).success).toBe(false)
      expect(SETTINGS['cancel.reasons'].schema.safeParse([1]).success).toBe(false)
    })
  })

  describe('portable settings (templates and profiles)', () => {
    it('leaves out the secret, the machine-local logo path and the separately carried modules', () => {
      expect(PORTABLE_SETTING_KEYS).not.toContain('tech.codeHash')
      expect(PORTABLE_SETTING_KEYS).not.toContain('business.logo')
      expect(PORTABLE_SETTING_KEYS).not.toContain('modules')
      expect(PORTABLE_SETTING_KEYS).toContain('business.legal')
      expect(PORTABLE_SETTING_KEYS).toHaveLength(SETTING_KEYS.length - 3)
    })

    it('accepts any subset and validates each value', () => {
      expect(portableSettingsSchema.safeParse({}).success).toBe(true)
      expect(portableSettingsSchema.safeParse({ 'receipt.lang': 'ar', 'day.cutoverHour': 2 }).success).toBe(true)
      expect(portableSettingsSchema.safeParse({ 'day.cutoverHour': 30 }).success).toBe(false)
    })

    it('rejects an unknown key and tech.codeHash', () => {
      expect(portableSettingsSchema.safeParse({ 'no.such.key': 1 }).success).toBe(false)
      expect(portableSettingsSchema.safeParse({ 'tech.codeHash': 'abc' }).success).toBe(false)
    })
  })
})
