import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '../../../src/shared/permissions'
import { verifySecret } from '../../../src/main/infrastructure/security/password'
import type { Result } from '../../../src/shared/result'
import { AMINE_PASSWORD, PINS, sessionOf, usersHarness, type UsersHarness } from '../../helpers/users'

// Every login or save costs a scrypt (~100 ms); a loaded machine must not turn that into a timeout.
vi.setConfig({ testTimeout: 30_000 })

const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)

interface Row {
  id: string
  display_name: string
  pin_hash: string
  username: string | null
  password_hash: string | null
  profile_id: string
  lang: string
  active: number
  failed_logins: number
  locked_until: string | null
  created_at: string
}

describe('saveUser', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  const user = (id: string): Row => h.t.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row
  const userCount = (): number => (h.t.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const newCashier = (over: Record<string, unknown> = {}) => ({
    displayName: 'Nadia Tazi',
    profileId: h.seeded.profiles.caissier,
    pin: '4567',
    ...over
  })

  it('needs users.manage', async () => {
    const r = await h.service.saveUser(h.cashier, newCashier())
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'users.manage' } } })
    expect(userCount()).toBe(3)
  })

  it('creates a user: id, hashed PIN, creation time, language, active, event logged', async () => {
    const r = await h.service.saveUser(h.manager, newCashier({ lang: 'ar' }))
    expect(r.ok).toBe(true)
    const id = (r as { ok: true; value: { id: string } }).value.id
    const row = user(id)
    expect(row).toMatchObject({
      display_name: 'Nadia Tazi',
      profile_id: 'p-caissier',
      lang: 'ar',
      active: 1,
      username: null,
      password_hash: null,
      failed_logins: 0,
      locked_until: null,
      created_at: '2026-10-22T10:00:00.000Z'
    })
    expect(row.pin_hash).toMatch(/^scrypt\$/)
    expect(row.pin_hash).not.toContain('4567')
    expect(verifySecret('4567', row.pin_hash)).toBe(true)

    expect((await h.service.loginPin(id, '4567')).ok).toBe(true)
    expect(h.service.listTillUsers().map((u) => u.displayName)).toContain('Nadia Tazi')

    const logged = h.eventRows().filter((e) => e.type === 'user.saved')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ entity: 'user', entity_id: id, user_id: 'u-amine' })
    expect(JSON.parse(logged[0]!.data_json!)).toEqual({
      created: true,
      pinChanged: true,
      passwordChanged: false,
      profileId: 'p-caissier',
      active: true
    })
    expect(JSON.stringify(h.eventRows())).not.toContain('4567')
  })

  it('refuses a PIN that is not 4 to 6 digits, writing nothing', async () => {
    for (const pin of ['123', '1234567', 'abcd', '12 34', '']) {
      expect(code(await h.service.saveUser(h.manager, newCashier({ pin }))), pin).toBe('invalid_pin_format')
    }
    expect(userCount()).toBe(3)
  })

  it('needs a PIN to create a user', async () => {
    expect(await h.service.saveUser(h.manager, newCashier({ pin: undefined }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'pin' } }
    })
  })

  it('refuses a PIN another user already has (pin_in_use), inactive users included', async () => {
    expect(code(await h.service.saveUser(h.manager, newCashier({ pin: PINS.sara })))).toBe('pin_in_use')
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-youssef'").run()
    expect(code(await h.service.saveUser(h.manager, newCashier({ pin: PINS.youssef })))).toBe('pin_in_use')
    expect(userCount()).toBe(3)
  })

  it('does not count the user being edited as a duplicate of themselves', async () => {
    const r = await h.service.saveUser(h.manager, {
      id: 'u-sara',
      displayName: 'Sara E.',
      profileId: h.seeded.profiles.caissier,
      pin: PINS.sara
    })
    expect(r.ok).toBe(true)
    expect(user('u-sara').display_name).toBe('Sara E.')
  })

  it('refuses to give a user the PIN of another when editing', async () => {
    const r = await h.service.saveUser(h.manager, {
      id: 'u-sara',
      displayName: 'Sara',
      profileId: h.seeded.profiles.caissier,
      pin: PINS.youssef
    })
    expect(code(r)).toBe('pin_in_use')
    expect(verifySecret(PINS.sara, user('u-sara').pin_hash)).toBe(true)
  })

  it('keeps the PIN, username and password when an edit does not mention them', async () => {
    const before = user('u-amine')
    const r = await h.service.saveUser(h.manager, {
      id: 'u-amine',
      displayName: 'Amine B.',
      profileId: h.seeded.profiles.gerant,
      lang: 'en'
    })
    expect(r.ok).toBe(true)
    const after = user('u-amine')
    expect(after).toMatchObject({ display_name: 'Amine B.', lang: 'en', active: 1 })
    expect(after.pin_hash).toBe(before.pin_hash)
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.username).toBe('amine')
    expect(after.created_at).toBe(before.created_at)
  })

  it('sets a username and password, stored hashed, usable for the back office', async () => {
    const r = await h.service.saveUser(h.manager, newCashier({ username: 'Nadia.T', password: 'Nadia-Pass-2026' }))
    expect(r.ok).toBe(true)
    const row = user((r as { ok: true; value: { id: string } }).value.id)
    expect(row.username).toBe('nadia.t')
    expect(verifySecret('Nadia-Pass-2026', row.password_hash!)).toBe(true)
    expect(JSON.stringify(h.eventRows())).not.toContain('Nadia-Pass-2026')
  })

  it('refuses a username that is taken, whatever its case', async () => {
    expect(code(await h.service.saveUser(h.manager, newCashier({ username: 'AMINE', password: 'Another-Pass-1' })))).toBe(
      'username_taken'
    )
    expect(userCount()).toBe(3)
  })

  it('lets a user keep their own username', async () => {
    const r = await h.service.saveUser(h.manager, {
      id: 'u-amine',
      displayName: 'Amine Benali',
      profileId: h.seeded.profiles.gerant,
      username: 'amine'
    })
    expect(r.ok).toBe(true)
  })

  it('needs a password of at least 8 characters, and a password for every username', async () => {
    expect(await h.service.saveUser(h.manager, newCashier({ username: 'nadia', password: 'short' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'password' } }
    })
    expect(await h.service.saveUser(h.manager, newCashier({ username: 'nadia' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'password' } }
    })
    expect(await h.service.saveUser(h.manager, newCashier({ username: 'bad name!', password: 'Long-Enough-1' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'username' } }
    })
    expect(userCount()).toBe(3)
  })

  it('removes the back office access when the username is cleared', async () => {
    const r = await h.service.saveUser(h.manager, {
      id: 'u-amine',
      displayName: 'Amine Benali',
      profileId: h.seeded.profiles.gerant,
      username: null
    })
    expect(r.ok).toBe(true)
    expect(user('u-amine')).toMatchObject({ username: null, password_hash: null })
    expect(code(await h.service.loginPassword('amine', AMINE_PASSWORD, 'c1'))).toBe('invalid_credentials')
  })

  it('refuses an unknown profile, an empty name and an unknown language', async () => {
    expect(await h.service.saveUser(h.manager, newCashier({ profileId: 'p-nope' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'profileId' } }
    })
    expect(await h.service.saveUser(h.manager, newCashier({ displayName: '   ' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'displayName' } }
    })
    expect(await h.service.saveUser(h.manager, newCashier({ lang: 'de' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'lang' } }
    })
  })

  it('refuses to edit a user that does not exist', async () => {
    expect(await h.service.saveUser(h.manager, newCashier({ id: 'u-ghost' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { field: 'id' } }
    })
  })

  it('unlocks a user whose PIN or password is reset', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    expect(user('u-sara').locked_until).not.toBeNull()
    await h.service.saveUser(h.manager, {
      id: 'u-sara',
      displayName: 'Sara',
      profileId: h.seeded.profiles.caissier,
      pin: '7777'
    })
    expect(user('u-sara')).toMatchObject({ failed_logins: 0, locked_until: null })
    expect((await h.service.loginPin('u-sara', '7777')).ok).toBe(true)
  })

  it('keeps two parallel saves from both taking the same PIN', async () => {
    const results = await Promise.all([
      h.service.saveUser(h.manager, newCashier({ displayName: 'A', pin: '8888' })),
      h.service.saveUser(h.manager, newCashier({ displayName: 'B', pin: '8888' }))
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.map(code)).toContain('pin_in_use')
  })

  describe('last manager', () => {
    it('refuses to deactivate the only active Gérant, leaving everything as it was', async () => {
      const r = await h.service.saveUser(h.manager, {
        id: 'u-amine',
        displayName: 'Amine Benali',
        profileId: h.seeded.profiles.gerant,
        active: false
      })
      expect(code(r)).toBe('last_manager')
      expect(user('u-amine').active).toBe(1)
      expect(h.eventRows().filter((e) => e.type === 'user.saved')).toHaveLength(0)
    })

    it('refuses to move the only Gérant to a profile without every permission', async () => {
      const r = await h.service.saveUser(h.manager, {
        id: 'u-amine',
        displayName: 'Amine Benali',
        profileId: h.seeded.profiles.caissier
      })
      expect(code(r)).toBe('last_manager')
      expect(user('u-amine').profile_id).toBe('p-gerant')
    })

    it('allows it once another active Gérant exists, and the second one then cannot go', async () => {
      const created = await h.service.saveUser(
        h.manager,
        newCashier({ displayName: 'Second Gérant', profileId: h.seeded.profiles.gerant, pin: '1111' })
      )
      expect(created.ok).toBe(true)
      const secondId = (created as { ok: true; value: { id: string } }).value.id

      const first = await h.service.saveUser(h.manager, {
        id: 'u-amine',
        displayName: 'Amine Benali',
        profileId: h.seeded.profiles.gerant,
        active: false
      })
      expect(first.ok).toBe(true)
      const second = await h.service.saveUser(sessionOf(secondId, PERMISSIONS, 10000), {
        id: secondId,
        displayName: 'Second Gérant',
        profileId: h.seeded.profiles.gerant,
        active: false
      })
      expect(code(second)).toBe('last_manager')
    })

    it('does not count a deactivated Gérant as a manager', async () => {
      await h.service.saveUser(h.manager, newCashier({ displayName: 'Other', profileId: h.seeded.profiles.gerant, pin: '1111' }))
      h.t.db.prepare("UPDATE users SET active = 0 WHERE profile_id = 'p-gerant' AND id <> 'u-amine'").run()
      const r = await h.service.saveUser(h.manager, {
        id: 'u-amine',
        displayName: 'Amine Benali',
        profileId: h.seeded.profiles.gerant,
        active: false
      })
      expect(code(r)).toBe('last_manager')
    })
  })
})

describe('saveProfile', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  const profile = (id: string) =>
    h.t.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as
      | { id: string; name_json: string; permissions_json: string; max_discount_bp: number }
      | undefined

  it('needs users.manage', () => {
    const r = h.service.saveProfile(h.cashier, { name: { fr: 'Stagiaire' }, permissions: [], maxDiscountBp: 0 })
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'users.manage' } } })
  })

  it('creates a profile', () => {
    const r = h.service.saveProfile(h.manager, {
      name: { fr: 'Superviseur', en: 'Supervisor' },
      permissions: ['order.discount', 'ticket.cancel'],
      maxDiscountBp: 2500
    })
    expect(r.ok).toBe(true)
    const row = profile((r as { ok: true; value: { id: string } }).value.id)!
    expect(JSON.parse(row.name_json)).toEqual({ fr: 'Superviseur', en: 'Supervisor' })
    expect(JSON.parse(row.permissions_json)).toEqual(['order.discount', 'ticket.cancel'])
    expect(row.max_discount_bp).toBe(2500)
    const logged = h.eventRows().filter((e) => e.type === 'profile.saved')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ entity: 'profile', user_id: 'u-amine' })
  })

  it('updates a profile', () => {
    const r = h.service.saveProfile(h.manager, {
      id: 'p-caissier',
      name: { fr: 'Caissier senior' },
      permissions: ['order.discount', 'report.x'],
      maxDiscountBp: 1500
    })
    expect(r).toEqual({ ok: true, value: { id: 'p-caissier' } })
    expect(profile('p-caissier')).toMatchObject({ max_discount_bp: 1500 })
    expect(JSON.parse(profile('p-caissier')!.permissions_json)).toEqual(['order.discount', 'report.x'])
  })

  it('refuses invalid input, naming the field', () => {
    const bad = (over: Record<string, unknown>) =>
      h.service.saveProfile(h.manager, { name: { fr: 'X' }, permissions: [], maxDiscountBp: 0, ...over } as never)
    expect(bad({ maxDiscountBp: 20000 })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'maxDiscountBp' } } })
    expect(bad({ permissions: ['teleport'] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(bad({ name: { fr: '' } })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'name.fr' } } })
    expect(bad({ id: 'p-ghost' })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'id' } } })
  })

  it('refuses to take a permission away from the only Gérant profile (last_manager), writing nothing', () => {
    const r = h.service.saveProfile(h.manager, {
      id: 'p-gerant',
      name: { fr: 'Gérant' },
      permissions: PERMISSIONS.filter((p) => p !== 'backup.restore'),
      maxDiscountBp: 10000
    })
    expect(code(r)).toBe('last_manager')
    expect(JSON.parse(profile('p-gerant')!.permissions_json)).toEqual([...PERMISSIONS])
  })

  it('allows it when another active manager keeps every permission', async () => {
    const other = await h.service.saveUser(h.manager, {
      displayName: 'Other',
      profileId: h.seeded.profiles.caissier,
      pin: '1111'
    })
    h.service.saveProfile(h.manager, {
      id: 'p-caissier',
      name: { fr: 'Caissier' },
      permissions: [...PERMISSIONS],
      maxDiscountBp: 1000
    })
    expect(other.ok).toBe(true)
    const r = h.service.saveProfile(h.manager, {
      id: 'p-gerant',
      name: { fr: 'Gérant' },
      permissions: PERMISSIONS.filter((p) => p !== 'backup.restore'),
      maxDiscountBp: 10000
    })
    expect(r.ok).toBe(true)
  })
})
