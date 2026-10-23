import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashSecret } from '../../../src/main/infrastructure/security/password'
import type { OverrideToken } from '../../../src/main/domain/users/session'
import type { Result } from '../../../src/shared/result'
import { PINS, TECHNICIAN_CODE, sessionOf, usersHarness, type UsersHarness } from '../../helpers/users'

// Every login or save costs a scrypt (~100 ms); a loaded machine must not turn that into a timeout.
vi.setConfig({ testTimeout: 30_000 })

const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)
const tokenOf = (r: Result<OverrideToken>): OverrideToken => {
  if (!r.ok) throw new Error(`expected a token, got ${r.error.code}`)
  return r.value
}

describe('authorizeOverride', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  it('gives a manager PIN a one-time token for the permission, valid 60 s', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(token).toMatchObject({
      byUserId: 'u-amine',
      permission: 'order.discount.override',
      expiresAt: '2026-10-22T10:01:00.000Z'
    })
  })

  it('logs the approval against the approving user, without the PIN', async () => {
    await h.service.authorizeOverride(PINS.amine, 'order.void_sent')
    const rows = h.eventRows()
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'override.granted',
        entity: 'override',
        user_id: 'u-amine',
        data_json: JSON.stringify({ permission: 'order.void_sent' })
      })
    ])
    expect(JSON.stringify(rows)).not.toContain(PINS.amine)
  })

  it('refuses a valid PIN whose profile lacks the permission as forbidden', async () => {
    const r = await h.service.authorizeOverride(PINS.sara, 'order.discount.override')
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'order.discount.override' } } })
  })

  it('refuses a PIN that matches nobody as invalid_credentials, and one of the wrong shape as invalid_pin_format', async () => {
    expect(code(await h.service.authorizeOverride('0000', 'order.discount.override'))).toBe('invalid_credentials')
    expect(code(await h.service.authorizeOverride('12', 'order.discount.override'))).toBe('invalid_pin_format')
  })

  it('ignores deactivated users', async () => {
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-amine'").run()
    expect(code(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))).toBe('invalid_credentials')
  })

  it("treats a locked-out manager's PIN as unknown, so the prompt cannot be used to probe locks", async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-amine', '0000')
    const r = await h.service.authorizeOverride(PINS.amine, 'order.discount.override')
    expect(code(r)).toBe('invalid_credentials')
    h.clock.advance(60_000)
    expect((await h.service.authorizeOverride(PINS.amine, 'order.discount.override')).ok).toBe(true)
  })

  it('logs every refusal, with its reason', async () => {
    await h.service.authorizeOverride('0000', 'order.void_sent')
    await h.service.authorizeOverride(PINS.sara, 'order.void_sent')
    const rows = h.eventRows()
    expect(rows.map((r) => [r.type, r.user_id, r.data_json])).toEqual([
      ['override.denied', null, JSON.stringify({ permission: 'order.void_sent', reason: 'bad_pin' })],
      ['override.denied', 'u-sara', JSON.stringify({ permission: 'order.void_sent', reason: 'forbidden' })]
    ])
  })

  it('locks guessing for 60 s after 5 refusals, even for a correct manager PIN, then recovers', async () => {
    for (let i = 0; i < 4; i++) expect(code(await h.service.authorizeOverride('0000', 'order.void_sent'))).toBe('invalid_credentials')
    const fifth = await h.service.authorizeOverride('0000', 'order.void_sent')
    expect(fifth).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:01:00.000Z' } } })
    expect(code(await h.service.authorizeOverride(PINS.amine, 'order.void_sent'))).toBe('locked')
    h.clock.advance(60_000)
    expect((await h.service.authorizeOverride(PINS.amine, 'order.void_sent')).ok).toBe(true)
  })

  it('counts a valid PIN that lacks the permission among the refusals', async () => {
    for (let i = 0; i < 5; i++) await h.service.authorizeOverride(PINS.sara, 'order.void_sent')
    expect(code(await h.service.authorizeOverride(PINS.amine, 'order.void_sent'))).toBe('locked')
  })

  it('forgets earlier refusals after an approval', async () => {
    for (let i = 0; i < 4; i++) await h.service.authorizeOverride('0000', 'order.void_sent')
    expect((await h.service.authorizeOverride(PINS.amine, 'order.void_sent')).ok).toBe(true)
    for (let i = 0; i < 4; i++) expect(code(await h.service.authorizeOverride('0000', 'order.void_sent'))).toBe('invalid_credentials')
  })
})

describe('discount guard (Caissier max 10 %)', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  it('allows up to the limit, inclusive: 10 % is fine', () => {
    expect(h.service.checkDiscount(h.cashier, 1000)).toEqual({ ok: true, value: {} })
    expect(h.service.checkDiscount(h.cashier, 0).ok).toBe(true)
  })

  it('denies 15 % without an override', () => {
    expect(h.service.checkDiscount(h.cashier, 1500)).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.discount.override', maxDiscountBp: 1000 } }
    })
    expect(code(h.service.checkDiscount(h.cashier, 1001))).toBe('forbidden')
  })

  it('allows 15 % with an override from a Gérant PIN, and names the approver', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(h.service.checkDiscount(h.cashier, 1500, token)).toEqual({ ok: true, value: { overriddenBy: 'u-amine' } })
  })

  it('uses the override once: the same approval cannot cover a second discount', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(h.service.checkDiscount(h.cashier, 1500, token).ok).toBe(true)
    expect(h.service.checkDiscount(h.cashier, 2000, token)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('does not spend the override on a discount that is within the limit', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(h.service.checkDiscount(h.cashier, 500, token).ok).toBe(true)
    expect(h.service.checkDiscount(h.cashier, 1500, token).ok).toBe(true)
  })

  it('refuses an expired override', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    h.clock.advance(60_000)
    expect(code(h.service.checkDiscount(h.cashier, 1500, token))).toBe('forbidden')
  })

  it('refuses an override granted for another permission', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.void_sent'))
    expect(code(h.service.checkDiscount(h.cashier, 1500, token))).toBe('forbidden')
  })

  it('refuses a user without order.discount, override or not', async () => {
    const nobody = sessionOf('u-x', ['report.x'], 10000)
    expect(h.service.checkDiscount(nobody, 100)).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.discount' } }
    })
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.discount.override'))
    expect(code(h.service.checkDiscount(nobody, 100, token))).toBe('forbidden')
  })

  it('gives a Serveur (0 %) no discount at all without an override', () => {
    const waiter = sessionOf('u-youssef', ['order.discount'], 0)
    expect(code(h.service.checkDiscount(waiter, 1))).toBe('forbidden')
  })

  it('refuses a discount that is not a whole number of basis points between 0 and 10000', () => {
    for (const bp of [-1, 10001, 12.5, Number.NaN]) {
      expect(h.service.checkDiscount(h.manager, bp), String(bp)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { field: 'discountBp' } }
      })
    }
  })
})

describe('consumeOverride', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  it('spends a token once and returns the approver', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.void_sent'))
    expect(h.service.consumeOverride(token, 'order.void_sent')).toEqual({ ok: true, value: { byUserId: 'u-amine' } })
    expect(h.service.consumeOverride(token, 'order.void_sent')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'order.void_sent', reason: 'override_invalid' } }
    })
  })
})

describe('verifyTechnician', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  const setCode = (): void => {
    h.uow.run((tx) => h.settings.set(tx, 'tech.codeHash', hashSecret(TECHNICIAN_CODE)))
  }

  it('is false while no technician code has been set', async () => {
    expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toBe(false)
  })

  it('accepts the technician code and refuses anything else', async () => {
    setCode()
    expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toBe(true)
    expect(await h.service.verifyTechnician('000000')).toBe(false)
    expect(await h.service.verifyTechnician('')).toBe(false)
  })

  it('is not a user PIN: a manager PIN does not open the technician menu', async () => {
    setCode()
    expect(await h.service.verifyTechnician(PINS.amine)).toBe(false)
  })

  it('logs each check without the code', async () => {
    setCode()
    await h.service.verifyTechnician('000000')
    await h.service.verifyTechnician(TECHNICIAN_CODE)
    const rows = h.eventRows().filter((e) => e.type.startsWith('technician.'))
    expect(rows.map((r) => [r.type, r.entity])).toEqual([
      ['technician.failed', 'technician'],
      ['technician.verified', 'technician']
    ])
    expect(JSON.stringify(h.eventRows())).not.toContain(TECHNICIAN_CODE)
    expect(JSON.stringify(h.eventRows())).not.toContain('000000')
  })
})
