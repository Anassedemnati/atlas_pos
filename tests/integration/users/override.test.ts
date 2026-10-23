import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashSecret } from '../../../src/main/infrastructure/security/password'
import type { OverrideToken } from '../../../src/main/domain/users/session'
import type { Result } from '../../../src/shared/result'
import { createUsersService } from '../../../src/main/application/usecases/users'
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

  it('answers a valid PIN whose profile lacks the permission exactly like a wrong PIN (no oracle on whose PIN is whose)', async () => {
    const nonManager = await h.service.authorizeOverride(PINS.sara, 'order.discount.override')
    const unknown = await h.service.authorizeOverride('0000', 'order.discount.override')
    expect(nonManager).toEqual({
      ok: false,
      error: { code: 'invalid_credentials', messageKey: 'errors.invalid_credentials' }
    })
    expect(nonManager).toEqual(unknown)
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
    // The reason is in the log even though the answer does not give it.
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

  it('is not affected by a back office lock: only a till lock keeps a manager from approving', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPassword('amine', 'wrong-password', 'c1')
    expect((await h.service.authorizeOverride(PINS.amine, 'order.void_sent')).ok).toBe(true)
  })

  it('refuses when the manager is deactivated, locked or given another PIN while the PIN is being checked', async () => {
    const run = async (change: string, ...args: unknown[]) => {
      const attempt = h.service.authorizeOverride(PINS.amine, 'order.void_sent')
      h.t.db.prepare(change).run(...args)
      return attempt
    }
    expect(code(await run("UPDATE users SET active = 0 WHERE id = 'u-amine'"))).toBe('invalid_credentials')
    h.t.db.prepare("UPDATE users SET active = 1 WHERE id = 'u-amine'").run()
    expect(
      code(await run("UPDATE users SET pin_locked_until = '2026-10-22T10:05:00.000Z' WHERE id = 'u-amine'"))
    ).toBe('invalid_credentials')
    h.t.db.prepare("UPDATE users SET pin_locked_until = NULL WHERE id = 'u-amine'").run()
    expect(code(await run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret('7777'), 'u-amine'))).toBe(
      'invalid_credentials'
    )
    expect(h.eventRows().filter((e) => e.type === 'override.granted')).toHaveLength(0)
  })

  it('refuses when the profile loses the permission while the PIN is being checked', async () => {
    const attempt = h.service.authorizeOverride(PINS.amine, 'order.void_sent')
    h.t.db.prepare("UPDATE profiles SET permissions_json = '[\"order.discount\"]' WHERE id = 'p-gerant'").run()
    expect(code(await attempt)).toBe('invalid_credentials')
  })

  it('cannot be out-run by a burst of parallel guesses: 5 refusals count, the rest find the prompt locked', async () => {
    const results = await Promise.all(Array.from({ length: 9 }, () => h.service.authorizeOverride('0000', 'order.void_sent')))
    expect(results.filter((r) => code(r) === 'invalid_credentials')).toHaveLength(4)
    expect(results.filter((r) => code(r) === 'locked')).toHaveLength(5)
    const rows = h.eventRows()
    expect(rows.filter((e) => e.type === 'override.denied')).toHaveLength(5)
    expect(rows.filter((e) => e.type === 'override.locked')).toHaveLength(1)
  })

  it('counts a valid PIN that lacks the permission among the refusals', async () => {
    for (let i = 0; i < 4; i++) {
      expect(code(await h.service.authorizeOverride(PINS.sara, 'order.void_sent'))).toBe('invalid_credentials')
    }
    expect(code(await h.service.authorizeOverride(PINS.sara, 'order.void_sent'))).toBe('locked')
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

  it('spends a token once and returns the approver and the permission, for the consuming use case to log', async () => {
    const token = tokenOf(await h.service.authorizeOverride(PINS.amine, 'order.void_sent'))
    expect(h.service.consumeOverride(token, 'order.void_sent')).toEqual({
      ok: true,
      value: { byUserId: 'u-amine', permission: 'order.void_sent' }
    })
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
  const technicianEvents = () => h.eventRows().filter((e) => e.type.startsWith('technician.'))

  it('accepts the technician code with { ok: true, value: true }', async () => {
    setCode()
    expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toEqual({ ok: true, value: true })
  })

  it('refuses a wrong code, an empty one and an over-long one as invalid_credentials', async () => {
    setCode()
    for (const wrong of ['000000', '', 'x'.repeat(300)]) {
      expect(code(await h.service.verifyTechnician(wrong)), wrong.slice(0, 8)).toBe('invalid_credentials')
    }
  })

  it('refuses while no technician code has been set', async () => {
    expect(code(await h.service.verifyTechnician(TECHNICIAN_CODE))).toBe('invalid_credentials')
  })

  it('is not a user PIN: a manager PIN does not open the technician menu', async () => {
    setCode()
    expect(code(await h.service.verifyTechnician(PINS.amine))).toBe('invalid_credentials')
  })

  it('locks for 5 minutes after 5 failures, even for the right code, then opens again', async () => {
    setCode()
    for (let i = 0; i < 4; i++) expect(code(await h.service.verifyTechnician('000000'))).toBe('invalid_credentials')
    const fifth = await h.service.verifyTechnician('000000')
    expect(fifth).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:05:00.000Z' } } })
    expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toMatchObject({
      ok: false,
      error: { code: 'locked', params: { until: '2026-10-22T10:05:00.000Z' } }
    })
    h.clock.advance(4 * 60_000)
    expect(code(await h.service.verifyTechnician(TECHNICIAN_CODE))).toBe('locked')
    h.clock.advance(60_000)
    expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toEqual({ ok: true, value: true })
  })

  it('forgets earlier failures after a success', async () => {
    setCode()
    for (let i = 0; i < 4; i++) await h.service.verifyTechnician('000000')
    expect((await h.service.verifyTechnician(TECHNICIAN_CODE)).ok).toBe(true)
    for (let i = 0; i < 4; i++) expect(code(await h.service.verifyTechnician('000000'))).toBe('invalid_credentials')
  })

  it('cannot be out-run by a burst of parallel guesses', async () => {
    setCode()
    const results = await Promise.all(Array.from({ length: 9 }, () => h.service.verifyTechnician('000000')))
    expect(results.filter((r) => code(r) === 'invalid_credentials')).toHaveLength(4)
    expect(results.filter((r) => code(r) === 'locked')).toHaveLength(5)
    expect(technicianEvents().filter((e) => e.type === 'technician.locked')).toHaveLength(1)
  })

  it('logs each check without the code, and a lock once', async () => {
    setCode()
    await h.service.verifyTechnician('000000')
    await h.service.verifyTechnician(TECHNICIAN_CODE)
    expect(technicianEvents().map((r) => [r.type, r.entity])).toEqual([
      ['technician.failed', 'technician'],
      ['technician.verified', 'technician']
    ])
    expect(JSON.stringify(h.eventRows())).not.toContain(TECHNICIAN_CODE)
    expect(JSON.stringify(h.eventRows())).not.toContain('000000')
  })

  it('says technician_unavailable when the stored hash does not read back, without counting it as a guess', async () => {
    h.t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('tech.codeHash', '\"\"', 'now')").run()
    for (let i = 0; i < 7; i++) {
      expect(await h.service.verifyTechnician(TECHNICIAN_CODE)).toEqual({
        ok: false,
        error: { code: 'technician_unavailable', messageKey: 'errors.technician_unavailable' }
      })
    }
    const types = technicianEvents().map((e) => e.type)
    expect(types).toEqual(Array(7).fill('technician.unavailable'))
    // Repaired: the right code opens at once, there is no lock to wait out.
    setCode()
    expect((await h.service.verifyTechnician(TECHNICIAN_CODE)).ok).toBe(true)
  })

  it('does not hide any other error as a wrong code', async () => {
    const broken = createUsersService({
      db: h.t.db,
      uow: h.uow,
      clock: h.clock,
      settings: {
        ...h.settings,
        get: () => {
          throw new Error('disk I/O error')
        }
      }
    })
    await expect(broken.verifyTechnician(TECHNICIAN_CODE)).rejects.toThrow('disk I/O error')
    expect(technicianEvents()).toEqual([])
  })
})
