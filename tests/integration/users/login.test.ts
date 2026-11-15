import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '../../../src/shared/permissions'
import { hashSecret } from '../../../src/main/infrastructure/security/password'
import type { Session } from '../../../src/main/domain/users/session'
import type { Result } from '../../../src/shared/result'
import { AMINE_PASSWORD, AMINE_USERNAME, PINS, usersHarness, type UsersHarness } from '../../helpers/users'

// Every login or save costs a scrypt (~100 ms); a loaded machine must not turn that into a timeout.
vi.setConfig({ testTimeout: 30_000 })

const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)

interface UserRow {
  failed_logins: number
  locked_until: string | null
}

describe('till PIN login', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  // The till door keeps its own counter and lock in the pin_* columns.
  const row = (id: string): UserRow =>
    h.t.db
      .prepare('SELECT pin_failed_logins AS failed_logins, pin_locked_until AS locked_until FROM users WHERE id = ?')
      .get(id) as UserRow

  it('lists the active users for the PIN tiles, in creation order, with initials and no secret', () => {
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-youssef'").run()
    const tiles = h.service.listTillUsers()
    expect(tiles).toEqual([
      { id: 'u-amine', displayName: 'Amine Benali', initials: 'AB' },
      { id: 'u-sara', displayName: 'Sara El Idrissi', initials: 'SE' }
    ])
  })

  it('opens a session with the profile permissions and the discount limit', async () => {
    const r = await h.service.loginPin(h.seeded.users.sara, PINS.sara)
    expect(r.ok).toBe(true)
    const session = (r as { ok: true; value: Session }).value
    expect(session).toMatchObject({
      userId: 'u-sara',
      displayName: 'Sara El Idrissi',
      lang: 'fr',
      maxDiscountBp: 1000,
      isTechnician: false
    })
    expect([...session.permissions].sort()).toEqual(['order.discount', 'report.x', 'ticket.reprint'])
  })

  it('gives the manager every permission', async () => {
    const r = await h.service.loginPin(h.seeded.users.amine, PINS.amine)
    expect(r.ok && [...r.value.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('refuses a wrong PIN with invalid_credentials and counts the failure', async () => {
    const r = await h.service.loginPin('u-sara', '0000')
    expect(r).toEqual({
      ok: false,
      error: { code: 'invalid_credentials', messageKey: 'errors.invalid_credentials' }
    })
    expect(row('u-sara').failed_logins).toBe(1)
  })

  it('refuses a PIN of the wrong shape with invalid_pin_format, without counting it', async () => {
    for (const pin of ['123', '1234567', 'abcd', '']) {
      expect(code(await h.service.loginPin('u-sara', pin)), pin).toBe('invalid_pin_format')
    }
    expect(row('u-sara').failed_logins).toBe(0)
  })

  it('answers an unknown or deactivated user like a wrong PIN', async () => {
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-youssef'").run()
    expect(code(await h.service.loginPin('u-nobody', '1234'))).toBe('invalid_credentials')
    expect(code(await h.service.loginPin('u-youssef', PINS.youssef))).toBe('invalid_credentials')
  })

  it('locks the user for 60 s after 5 failures, and a correct PIN is refused meanwhile', async () => {
    for (let i = 0; i < 4; i++) expect(code(await h.service.loginPin('u-sara', '0000'))).toBe('invalid_credentials')
    const fifth = await h.service.loginPin('u-sara', '0000')
    expect(fifth).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:01:00.000Z' } } })

    const correct = await h.service.loginPin('u-sara', PINS.sara)
    expect(correct).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:01:00.000Z' } } })
    expect(row('u-sara').locked_until).toBe('2026-10-22T10:01:00.000Z')
    // The back office door of the same user is untouched.
    expect(
      h.t.db.prepare("SELECT failed_logins, locked_until FROM users WHERE id = 'u-sara'").get()
    ).toEqual({ failed_logins: 0, locked_until: null })
  })

  it('keeps the lock across an application restart (it lives in the database)', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    const afterRestart = h.restart()
    expect(code(await afterRestart.loginPin('u-sara', PINS.sara))).toBe('locked')
  })

  it('lets the user in once the 60 s are over, and clears the failure count', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    h.clock.advance(60_000)
    expect((await h.service.loginPin('u-sara', PINS.sara)).ok).toBe(true)
    expect(row('u-sara')).toEqual({ failed_logins: 0, locked_until: null })
  })

  it('gives a fresh set of 5 tries after a lock, not one', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    h.clock.advance(60_000)
    expect(code(await h.service.loginPin('u-sara', '0000'))).toBe('invalid_credentials')
    expect(row('u-sara').failed_logins).toBe(1)
  })

  it('forgets earlier failures on a successful login', async () => {
    for (let i = 0; i < 3; i++) await h.service.loginPin('u-sara', '0000')
    expect((await h.service.loginPin('u-sara', PINS.sara)).ok).toBe(true)
    for (let i = 0; i < 4; i++) expect(code(await h.service.loginPin('u-sara', '0000'))).toBe('invalid_credentials')
    expect(row('u-sara').failed_logins).toBe(4)
  })

  it('does not count or hash an attempt made while locked', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    const before = h.eventRows().length
    await h.service.loginPin('u-sara', '0000')
    expect(row('u-sara').failed_logins).toBe(0)
    expect(h.eventRows()).toHaveLength(before)
  })

  it('refuses when the PIN is changed while it is being checked: the answer was about a secret that is gone', async () => {
    // The call runs up to its first await (the hash) before this line continues: the edit lands in between.
    const attempt = h.service.loginPin('u-sara', PINS.sara)
    h.t.db.prepare("UPDATE users SET pin_hash = ? WHERE id = 'u-sara'").run(hashSecret('7777'))
    expect(code(await attempt)).toBe('invalid_credentials')
    expect(row('u-sara').failed_logins).toBe(0)
    expect((await h.service.loginPin('u-sara', '7777')).ok).toBe(true)
  })

  it('refuses when the user is deactivated while the PIN is being checked', async () => {
    const attempt = h.service.loginPin('u-sara', PINS.sara)
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-sara'").run()
    expect(code(await attempt)).toBe('invalid_credentials')
  })

  it('locks other users independently', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    expect((await h.service.loginPin('u-youssef', PINS.youssef)).ok).toBe(true)
  })

  it('cannot be out-run by a burst of parallel guesses: 5 failures count, the rest find it locked', async () => {
    const results = await Promise.all(Array.from({ length: 9 }, () => h.service.loginPin('u-sara', '0000')))
    expect(results.filter((r) => code(r) === 'invalid_credentials')).toHaveLength(4)
    expect(results.filter((r) => code(r) === 'locked')).toHaveLength(5)
    expect(h.eventRows().filter((e) => e.type === 'user.locked')).toHaveLength(1)
  })

  it('writes the login and the failures to the event log, with no secret in it', async () => {
    await h.service.loginPin('u-sara', '9876')
    await h.service.loginPin('u-sara', PINS.sara)
    const rows = h.eventRows()
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'user.login_failed',
        entity: 'user',
        entity_id: 'u-sara',
        user_id: 'u-sara',
        data_json: JSON.stringify({ channel: 'pin', reason: 'bad_secret' })
      }),
      expect.objectContaining({
        type: 'user.login',
        entity: 'user',
        entity_id: 'u-sara',
        user_id: 'u-sara',
        data_json: JSON.stringify({ channel: 'pin' })
      })
    ])
    const text = JSON.stringify(rows)
    expect(text).not.toContain('9876')
    expect(text).not.toContain(PINS.sara)
    expect(text).not.toContain('scrypt$')
  })

  it('logs the lock once, with its end', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-sara', '0000')
    const locked = h.eventRows().filter((e) => e.type === 'user.locked')
    expect(locked).toHaveLength(1)
    expect(JSON.parse(locked[0]!.data_json!)).toEqual({ channel: 'pin', until: '2026-10-22T10:01:00.000Z' })
  })
})

describe('back office password login', () => {
  let h: UsersHarness
  beforeEach(() => {
    h = usersHarness()
  })
  afterEach(() => h.cleanup())

  const row = (id: string): UserRow =>
    h.t.db.prepare('SELECT failed_logins, locked_until FROM users WHERE id = ?').get(id) as UserRow

  it('opens a session for a user who may log in to the back office', async () => {
    const r = await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, '192.168.1.20')
    expect(r).toMatchObject({
      ok: true,
      value: { userId: 'u-amine', displayName: 'Amine Benali', maxDiscountBp: 10000, isTechnician: false }
    })
  })

  it('finds the account whatever the case of the username', async () => {
    expect((await h.service.loginPassword('  AMINE ', AMINE_PASSWORD, 'c1')).ok).toBe(true)
  })

  it('refuses a wrong password with invalid_credentials', async () => {
    expect(code(await h.service.loginPassword(AMINE_USERNAME, 'wrong', 'c1'))).toBe('invalid_credentials')
    expect(row('u-amine').failed_logins).toBe(1)
  })

  it('answers an unknown username, a user without a password and a deactivated user the same way', async () => {
    h.t.db.prepare("UPDATE users SET username = 'sara', active = 1 WHERE id = 'u-sara'").run()
    expect(code(await h.service.loginPassword('nobody', 'whatever1', 'c1'))).toBe('invalid_credentials')
    expect(code(await h.service.loginPassword('sara', 'whatever1', 'c2'))).toBe('invalid_credentials')
    h.t.db.prepare("UPDATE users SET active = 0 WHERE id = 'u-amine'").run()
    expect(code(await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c3'))).toBe('invalid_credentials')
  })

  it('locks the user for 15 minutes after 5 wrong passwords: the 6th attempt, correct, is locked', async () => {
    for (let i = 0; i < 4; i++) {
      expect(code(await h.service.loginPassword(AMINE_USERNAME, 'wrong', 'c1'))).toBe('invalid_credentials')
    }
    expect(code(await h.service.loginPassword(AMINE_USERNAME, 'wrong', 'c1'))).toBe('locked')

    const sixth = await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c1')
    expect(sixth).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:15:00.000Z' } } })
    expect(row('u-amine').locked_until).toBe('2026-10-22T10:15:00.000Z')

    h.clock.advance(14 * 60_000)
    expect(code(await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c1'))).toBe('locked')
    h.clock.advance(60_000)
    expect((await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c1')).ok).toBe(true)
    expect(row('u-amine')).toEqual({ failed_logins: 0, locked_until: null })
  })

  it('keeps a separate counter and lock per door: a web lock does not block the till PIN, and vice versa', async () => {
    for (let i = 0; i < 5; i++) await h.service.loginPassword(AMINE_USERNAME, 'wrong', 'c1')
    expect(row('u-amine').locked_until).toBe('2026-10-22T10:15:00.000Z')
    // Locked on the web, still welcome at the till, and the till does not carry the web failures.
    expect((await h.service.loginPin('u-amine', PINS.amine)).ok).toBe(true)

    h.t.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = 'u-amine'").run()
    for (let i = 0; i < 5; i++) await h.service.loginPin('u-amine', '0000')
    expect(code(await h.service.loginPin('u-amine', PINS.amine))).toBe('locked')
    expect((await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c1')).ok).toBe(true)
  })

  it('does not add the failures of the two doors together', async () => {
    for (let i = 0; i < 3; i++) await h.service.loginPin('u-amine', '0000')
    for (let i = 0; i < 4; i++) await h.service.loginPassword(AMINE_USERNAME, 'wrong', 'c1')
    expect(row('u-amine')).toEqual({ failed_logins: 4, locked_until: null })
    expect(
      h.t.db.prepare("SELECT pin_failed_logins, pin_locked_until FROM users WHERE id = 'u-amine'").get()
    ).toEqual({ pin_failed_logins: 3, pin_locked_until: null })
    // A success on one door clears that door only.
    expect((await h.service.loginPin('u-amine', PINS.amine)).ok).toBe(true)
    expect(row('u-amine').failed_logins).toBe(4)
  })

  it('refuses when the password is changed or removed while it is being checked', async () => {
    const changed = h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, 'c1')
    h.t.db.prepare("UPDATE users SET password_hash = ? WHERE id = 'u-amine'").run(hashSecret('Another-Password-7'))
    expect(code(await changed)).toBe('invalid_credentials')
    expect(row('u-amine').failed_logins).toBe(0)

    const removed = h.service.loginPassword(AMINE_USERNAME, 'Another-Password-7', 'c1')
    h.t.db.prepare("UPDATE users SET username = NULL, password_hash = NULL WHERE id = 'u-amine'").run()
    expect(code(await removed)).toBe('invalid_credentials')
  })

  it('answers an over-long username or password like an unknown user, without hashing it', async () => {
    expect(code(await h.service.loginPassword('a'.repeat(65), 'whatever1', 'c1'))).toBe('invalid_credentials')
    expect(code(await h.service.loginPassword(AMINE_USERNAME, 'p'.repeat(257), 'c1'))).toBe('invalid_credentials')
    // Counted against the client, not against the user it named.
    expect(row('u-amine').failed_logins).toBe(0)
    const failures = h.eventRows().filter((e) => e.type === 'user.login_failed')
    expect(failures.map((e) => JSON.parse(e.data_json!).reason)).toEqual(['unknown_user', 'unknown_user'])
    expect(JSON.stringify(h.eventRows())).not.toContain('pppppppppp')
  })

  it('cuts a very long clientKey, in the limiter and in the log', async () => {
    const long = 'x'.repeat(5000)
    for (let i = 0; i < 4; i++) await h.service.loginPassword(`ghost${i}`, 'whatever1', long + i)
    // The tails differ, the first 128 characters do not: it is one client.
    expect(code(await h.service.loginPassword('ghost4', 'whatever1', `${long}z`))).toBe('locked')
    const logged = h.eventRows().map((e) => (e.data_json ? JSON.parse(e.data_json).clientKey : undefined))
    for (const key of logged.filter((k) => k !== undefined)) expect(key).toHaveLength(128)
  })

  it('refuses a correct password without backoffice.login as forbidden, and does not count it as a failure', async () => {
    h.t.db
      .prepare("UPDATE users SET username = 'sara', password_hash = ? WHERE id = 'u-sara'")
      .run(hashSecret('Sara-Password-1'))
    for (let i = 0; i < 6; i++) {
      const r = await h.service.loginPassword('sara', 'Sara-Password-1', 'c1')
      expect(r).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'backoffice.login' } } })
    }
    expect(row('u-sara')).toEqual({ failed_logins: 0, locked_until: null })
  })

  it('blocks a client that keeps trying unknown usernames, after 5 tries, for 15 minutes', async () => {
    for (let i = 0; i < 4; i++) {
      expect(code(await h.service.loginPassword(`ghost${i}`, 'whatever1', '10.0.0.9'))).toBe('invalid_credentials')
    }
    const fifth = await h.service.loginPassword('ghost4', 'whatever1', '10.0.0.9')
    expect(fifth).toMatchObject({ ok: false, error: { code: 'locked', params: { until: '2026-10-22T10:15:00.000Z' } } })
    // That client is blocked whatever it types next; another client is not.
    expect(code(await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, '10.0.0.9'))).toBe('locked')
    expect((await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, '10.0.0.10')).ok).toBe(true)
    h.clock.advance(15 * 60_000)
    expect((await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, '10.0.0.9')).ok).toBe(true)
  })

  it('writes the client to the event log and never the password or the username that was typed', async () => {
    await h.service.loginPassword(AMINE_USERNAME, 'Typo-Password-9', '192.168.1.20')
    await h.service.loginPassword('typed-a-password-here', 'whatever1', '192.168.1.21')
    await h.service.loginPassword(AMINE_USERNAME, AMINE_PASSWORD, '192.168.1.20')
    const rows = h.eventRows()
    expect(rows.map((r) => [r.type, r.user_id, r.data_json])).toEqual([
      ['user.login_failed', 'u-amine', JSON.stringify({ channel: 'password', reason: 'bad_secret', clientKey: '192.168.1.20' })],
      ['user.login_failed', null, JSON.stringify({ channel: 'password', reason: 'unknown_user', clientKey: '192.168.1.21' })],
      ['user.login', 'u-amine', JSON.stringify({ channel: 'password', clientKey: '192.168.1.20' })]
    ])
    const text = JSON.stringify(rows)
    for (const secret of ['Typo-Password-9', 'typed-a-password-here', AMINE_PASSWORD, 'scrypt$']) {
      expect(text).not.toContain(secret)
    }
  })
})
