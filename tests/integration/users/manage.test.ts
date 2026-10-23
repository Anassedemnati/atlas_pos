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

  it("lifts the till lock when the PIN is reset, and leaves the back office lock alone", async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-amine', '0000')
    for (let i = 0; i < 5; i++) await h.service.loginPassword('amine', 'wrong-password', 'c1')
    const state = () =>
      h.t.db
        .prepare("SELECT pin_failed_logins, pin_locked_until, failed_logins, locked_until FROM users WHERE id = 'u-amine'")
        .get() as { pin_locked_until: string | null; locked_until: string | null }
    expect(state().pin_locked_until).not.toBeNull()
    expect(state().locked_until).not.toBeNull()

    const r = await h.service.saveUser(h.manager, {
      id: 'u-amine',
      displayName: 'Amine Benali',
      profileId: h.seeded.profiles.gerant,
      pin: '7777'
    })
    expect(r.ok).toBe(true)
    expect(state()).toMatchObject({ pin_failed_logins: 0, pin_locked_until: null })
    expect(state().locked_until).not.toBeNull()
    expect((await h.service.loginPin('u-amine', '7777')).ok).toBe(true)
  })

  it('lifts the back office lock when the password is reset, and leaves the till lock alone', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-amine', '0000')
    for (let i = 0; i < 5; i++) await h.service.loginPassword('amine', 'wrong-password', 'c1')

    const r = await h.service.saveUser(h.manager, {
      id: 'u-amine',
      displayName: 'Amine Benali',
      profileId: h.seeded.profiles.gerant,
      password: 'Brand-New-Password-1'
    })
    expect(r.ok).toBe(true)
    expect(user('u-amine')).toMatchObject({ failed_logins: 0, locked_until: null })
    expect(
      (h.t.db.prepare("SELECT pin_locked_until AS p FROM users WHERE id = 'u-amine'").get() as { p: string | null }).p
    ).not.toBeNull()
    expect((await h.service.loginPassword('amine', 'Brand-New-Password-1', 'c1')).ok).toBe(true)
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
    const promoted = h.service.saveProfile(h.manager, {
      id: 'p-caissier',
      name: { fr: 'Caissier' },
      permissions: [...PERMISSIONS],
      maxDiscountBp: 1000
    })
    expect(other.ok).toBe(true)
    expect(promoted.ok).toBe(true)
    const r = h.service.saveProfile(h.manager, {
      id: 'p-gerant',
      name: { fr: 'Gérant' },
      permissions: PERMISSIONS.filter((p) => p !== 'backup.restore'),
      maxDiscountBp: 10000
    })
    expect(r.ok).toBe(true)
  })
})

describe('privilege boundary: a session only hands out what it holds', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  // A sub-manager: may manage users, but holds neither every permission nor backup.restore.
  const SUB_PERMISSIONS = ['users.manage', 'order.discount', 'report.x', 'ticket.reprint'] as const
  const sub = () => sessionOf('u-sub', SUB_PERMISSIONS, 2000)
  const escalation = { ok: false, error: { code: 'forbidden', params: { reason: 'privilege_escalation' } } }

  const row = (id: string) => h.t.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>
  const profileRow = (id: string) =>
    h.t.db.prepare('SELECT permissions_json, max_discount_bp FROM profiles WHERE id = ?').get(id) as {
      permissions_json: string
      max_discount_bp: number
    }
  const count = (table: string): number =>
    (h.t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  it('refuses to create a user on a profile that holds more than the session', async () => {
    const r = await h.service.saveUser(sub(), { displayName: 'New Gérant', profileId: h.seeded.profiles.gerant, pin: '4567' })
    expect(r).toMatchObject(escalation)
    expect(count('users')).toBe(3)
  })

  it("refuses to edit a Gérant: no PIN reset, no password reset, no deactivation, no move to a lower profile", async () => {
    const before = row('u-amine')
    const gerant = h.seeded.profiles.gerant
    const edits = [
      { pin: '4567' },
      { password: 'Attacker-Password-1' },
      { active: false },
      { profileId: h.seeded.profiles.serveur },
      { displayName: 'Renamed' }
    ]
    for (const edit of edits) {
      const r = await h.service.saveUser(sub(), { id: 'u-amine', displayName: 'Amine Benali', profileId: gerant, ...edit })
      expect(r, JSON.stringify(edit)).toMatchObject(escalation)
    }
    expect(row('u-amine')).toEqual(before)
  })

  it('refuses to move a user up to a profile that holds more than the session', async () => {
    const r = await h.service.saveUser(sub(), {
      id: 'u-sara',
      displayName: 'Sara',
      profileId: h.seeded.profiles.gerant
    })
    expect(r).toMatchObject(escalation)
    expect(row('u-sara')['profile_id']).toBe('p-caissier')
  })

  it("answers with the refusal, not with a PIN check, so a refused session learns nothing about other users' PINs", async () => {
    const r = await h.service.saveUser(sub(), {
      id: 'u-amine',
      displayName: 'Amine Benali',
      profileId: h.seeded.profiles.gerant,
      pin: PINS.sara
    })
    expect(r).toMatchObject(escalation)
  })

  it('still lets it manage users whose profile it covers', async () => {
    const created = await h.service.saveUser(sub(), {
      displayName: 'Nadia',
      profileId: h.seeded.profiles.caissier,
      pin: '4567'
    })
    expect(created.ok).toBe(true)
    const edited = await h.service.saveUser(sub(), {
      id: 'u-sara',
      displayName: 'Sara E.',
      profileId: h.seeded.profiles.serveur,
      pin: '7777'
    })
    expect(edited.ok).toBe(true)
  })

  it('refuses to create or edit a profile with a permission the session lacks', () => {
    const create = h.service.saveProfile(sub(), {
      name: { fr: 'Chef' },
      permissions: ['order.discount', 'backup.restore'],
      maxDiscountBp: 0
    })
    expect(create).toMatchObject(escalation)
    const grow = h.service.saveProfile(sub(), {
      id: 'p-caissier',
      name: { fr: 'Caissier' },
      permissions: [...JSON.parse(profileRow('p-caissier').permissions_json), 'settings.manage'],
      maxDiscountBp: 1000
    })
    expect(grow).toMatchObject(escalation)
    expect(count('profiles')).toBe(3)
    expect(JSON.parse(profileRow('p-caissier').permissions_json)).toEqual(['order.discount', 'report.x', 'ticket.reprint'])
  })

  it('refuses to edit a profile that holds more than the session, even to shrink it', () => {
    const before = profileRow('p-gerant')
    const r = h.service.saveProfile(sub(), {
      id: 'p-gerant',
      name: { fr: 'Gérant' },
      permissions: ['order.discount'],
      maxDiscountBp: 0
    })
    expect(r).toMatchObject(escalation)
    expect(profileRow('p-gerant')).toEqual(before)
  })

  it('still lets it create and edit profiles within its own permissions', () => {
    const created = h.service.saveProfile(sub(), {
      name: { fr: 'Stagiaire' },
      permissions: ['order.discount', 'report.x'],
      maxDiscountBp: 500
    })
    expect(created.ok).toBe(true)
    const edited = h.service.saveProfile(sub(), {
      id: 'p-caissier',
      name: { fr: 'Caissier' },
      permissions: ['order.discount', 'users.manage'],
      maxDiscountBp: 1000
    })
    expect(edited.ok).toBe(true)
  })

  describe('discount limits', () => {
    // sub() has a 20 % limit and no order.discount.override.
    const senior = () =>
      h.service.saveProfile(h.manager, { name: { fr: 'Senior' }, permissions: ['order.discount'], maxDiscountBp: 5000 })
    const idOf = (r: { ok: boolean; value?: { id: string } }): string => r.value!.id
    const limit = (id: string): number => profileRow(id).max_discount_bp

    it('refuses to create a profile with a higher discount limit than the session, and to raise one', () => {
      const create = h.service.saveProfile(sub(), { name: { fr: 'Libre' }, permissions: ['order.discount'], maxDiscountBp: 10000 })
      expect(create).toMatchObject(escalation)
      const raise = h.service.saveProfile(sub(), {
        id: 'p-caissier',
        name: { fr: 'Caissier' },
        permissions: ['order.discount', 'report.x', 'ticket.reprint'],
        maxDiscountBp: 2001
      })
      expect(raise).toMatchObject(escalation)
      expect(count('profiles')).toBe(3)
      expect(limit('p-caissier')).toBe(1000)
    })

    it('allows a limit up to its own, inclusive', () => {
      const r = h.service.saveProfile(sub(), {
        id: 'p-caissier',
        name: { fr: 'Caissier' },
        permissions: ['order.discount', 'report.x', 'ticket.reprint'],
        maxDiscountBp: 2000
      })
      expect(r.ok).toBe(true)
      expect(limit('p-caissier')).toBe(2000)
    })

    it('refuses to edit a profile whose current limit is above its own, even to lower it', () => {
      const id = idOf(senior() as { ok: boolean; value?: { id: string } })
      const r = h.service.saveProfile(sub(), { id, name: { fr: 'Senior' }, permissions: ['order.discount'], maxDiscountBp: 100 })
      expect(r).toMatchObject(escalation)
      expect(limit(id)).toBe(5000)
    })

    it('refuses to assign a cashier to a higher-limit profile, and to edit a user already on one', async () => {
      const id = idOf(senior() as { ok: boolean; value?: { id: string } })
      const before = row('u-sara')
      const move = await h.service.saveUser(sub(), { id: 'u-sara', displayName: 'Sara', profileId: id })
      expect(move).toMatchObject(escalation)
      expect(row('u-sara')).toEqual(before)

      // A user who is already on that profile cannot be edited either: no PIN reset of a higher-limit user.
      h.t.db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(id, 'u-youssef')
      const reset = await h.service.saveUser(sub(), { id: 'u-youssef', displayName: 'Youssef', profileId: 'p-serveur', pin: '7777' })
      expect(reset).toMatchObject(escalation)
      const create = await h.service.saveUser(sub(), { displayName: 'New', profileId: id, pin: '4567' })
      expect(create).toMatchObject(escalation)
    })

    it('lets a full manager (order.discount.override) set any limit, as long as it holds the permissions', async () => {
      const lead = sessionOf(
        'u-lead',
        ['users.manage', 'order.discount', 'order.discount.override', 'report.x', 'ticket.reprint'],
        0
      )
      const profile = h.service.saveProfile(lead, { name: { fr: 'Libre' }, permissions: ['order.discount'], maxDiscountBp: 10000 })
      expect(profile.ok).toBe(true)
      const assigned = await h.service.saveUser(lead, { id: 'u-sara', displayName: 'Sara', profileId: idOf(profile as never) })
      expect(assigned.ok).toBe(true)
      // The permission part of the boundary still applies to it.
      const over = h.service.saveProfile(lead, { name: { fr: 'X' }, permissions: ['backup.restore'], maxDiscountBp: 0 })
      expect(over).toMatchObject(escalation)
    })

    it('lets the Gérant create a 100 % profile and assign it', async () => {
      const profile = h.service.saveProfile(h.manager, { name: { fr: 'Libre' }, permissions: ['order.discount'], maxDiscountBp: 10000 })
      expect(profile.ok).toBe(true)
      const assigned = await h.service.saveUser(h.manager, { id: 'u-sara', displayName: 'Sara', profileId: idOf(profile as never) })
      expect(assigned.ok).toBe(true)
    })
  })

  it('does not restrict a session that holds everything', async () => {
    const r = await h.service.saveUser(h.manager, { displayName: 'Another Gérant', profileId: h.seeded.profiles.gerant, pin: '4567' })
    expect(r.ok).toBe(true)
  })
})
