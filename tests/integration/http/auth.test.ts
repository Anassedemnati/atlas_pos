import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { body, KARIM, startHttp, YOUSSEF, type Http } from './harness'

let h: Http
beforeAll(async () => {
  h = await startHttp()
})
afterAll(async () => {
  await h.close()
})

describe('the LAN-only guard and the security headers', () => {
  it('answers 403 to a client outside the local network, on the page, the files and the API alike', async () => {
    for (const url of ['/api/auth/me', '/admin', '/assets/app.js', '/media/x.png']) {
      const response = await h.app.inject({ method: 'GET', url, remoteAddress: '8.8.8.8' })
      expect(response.statusCode, url).toBe(403)
      expect(body(response)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'not_lan' } } })
    }
    const login = await h.login(KARIM, '8.8.8.8')
    expect(login.statusCode).toBe(403)
    expect(login.cookies).toHaveLength(0)
  })

  it('lets the private ranges in', async () => {
    for (const remoteAddress of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.20', '169.254.3.4', '::1', 'fd12:3456::7', 'fe80::1', '::ffff:192.168.1.5']) {
      const response = await h.app.inject({ method: 'GET', url: '/admin', remoteAddress })
      expect(response.statusCode, remoteAddress).toBe(200)
    }
    for (const remoteAddress of ['172.32.0.1', '11.0.0.1', '192.169.0.1', '2001:db8::1', '::ffff:8.8.8.8', '100.64.0.1']) {
      const response = await h.app.inject({ method: 'GET', url: '/admin', remoteAddress })
      expect(response.statusCode, remoteAddress).toBe(403)
    }
  })

  it('sends the security headers on every response', async () => {
    for (const url of ['/admin', '/assets/app.js', '/api/auth/me', '/nothing']) {
      const response = await h.app.inject({ method: 'GET', url })
      expect(response.headers['content-security-policy'], url).toContain("default-src 'self'")
      expect(response.headers['x-frame-options'], url).toBe('DENY')
      expect(response.headers['x-content-type-options'], url).toBe('nosniff')
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me' })).headers['cache-control']).toBe('no-store')
    expect((await h.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(302)
    expect((await h.app.inject({ method: 'GET', url: '/admin/assets/app.js' })).statusCode).toBe(200)
  })
})

describe('login, sessions and CSRF', () => {
  it('signs a manager in with an HttpOnly SameSite=Strict cookie, and keeps the CSRF token for the page', async () => {
    const response = await h.login()
    expect(response.statusCode).toBe(200)
    const cookie = response.cookies[0]!
    expect(cookie).toMatchObject({ name: 'atlas_sid', httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 8 * 3600 })
    const value = body<{ value: { csrfToken: string; user: { displayName: string } } }>(response).value
    expect(value.csrfToken).toHaveLength(43)
    expect(value.user.displayName).toBe('Karim')
    // A page reload asks again who is signed in, and gets the same token.
    const me = await h.api('GET', '/api/auth/me')
    expect(body<{ value: { csrfToken: string } }>(me).value.csrfToken).toBe(value.csrfToken)
  })

  it('needs a session for everything else', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/catalog' })
    expect(response.statusCode).toBe(401)
    expect(body(response)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    expect((await h.app.inject({ method: 'GET', url: '/api/catalog', headers: { cookie: 'atlas_sid=forged' } })).statusCode).toBe(401)
  })

  it('refuses a request that changes something without the CSRF token, or with another one', async () => {
    const category = { name: { fr: 'Sans CSRF' } }
    const without = await h.app.inject({ method: 'POST', url: '/api/catalog/categories', headers: { cookie: h.cookie }, payload: category })
    expect(without.statusCode).toBe(403)
    expect(body(without)).toMatchObject({ error: { code: 'forbidden', params: { reason: 'csrf' } } })
    const wrong = await h.app.inject({ method: 'POST', url: '/api/catalog/categories', headers: { cookie: h.cookie, 'x-csrf-token': 'x'.repeat(43) }, payload: category })
    expect(wrong.statusCode).toBe(403)
    const foreign = await h.app.inject({
      method: 'POST',
      url: '/api/catalog/categories',
      headers: { cookie: h.cookie, 'x-csrf-token': h.csrf, origin: 'http://evil.example' },
      payload: category
    })
    expect(foreign.statusCode).toBe(403)
    expect(body(foreign)).toMatchObject({ error: { params: { reason: 'origin' } } })
    const catalog = body<{ value: { categories: { name: { fr: string } }[] } }>(await h.api('GET', '/api/catalog')).value
    expect(catalog.categories.some((c) => c.name.fr === 'Sans CSRF')).toBe(false)
    // The right token, and the page's own origin, go through.
    const good = await h.app.inject({
      method: 'POST',
      url: '/api/catalog/categories',
      headers: { cookie: h.cookie, 'x-csrf-token': h.csrf, origin: 'http://192.168.1.20:8080', host: '192.168.1.20:8080' },
      payload: { name: { fr: 'Avec CSRF' } }
    })
    expect(good.statusCode).toBe(200)
  })

  it('refuses a user without the back office permission (Serveur) with 403', async () => {
    const response = await h.login(YOUSSEF)
    expect(response.statusCode).toBe(403)
    expect(body(response)).toMatchObject({ ok: false, error: { code: 'forbidden', params: { permission: 'backoffice.login' } } })
    expect(response.cookies).toHaveLength(0)
  })

  it('signs out: the cookie stops working', async () => {
    const other = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: KARIM.username, password: KARIM.password } })
    const cookie = `atlas_sid=${other.cookies[0]!.value}`
    const csrf = body<{ value: { csrfToken: string } }>(other).value.csrfToken
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200)
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(403)
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': csrf } })).statusCode).toBe(200)
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
  })

  it('drops the session of a user whose profile loses the permission', async () => {
    const services = h.runtime.services()!
    const profile = services.usersRepo.getProfile(services.usersRepo.getUser(services.users.listTillUsers()[0]!.id)!.profileId)!
    const login = await h.login(KARIM)
    expect(login.statusCode).toBe(200)
    services.uow.run((tx) => services.usersRepo.updateProfile(tx, { ...profile, permissions: profile.permissions.filter((p) => p !== 'backoffice.login') }))
    expect((await h.api('GET', '/api/catalog')).statusCode).toBe(401)
    services.uow.run((tx) => services.usersRepo.updateProfile(tx, profile))
    await h.login(KARIM)
  })
})

describe('the lockout', () => {
  it('locks the user after 5 wrong passwords: the 6th attempt is refused even with the right one', async () => {
    const karim = (password: string) => h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: KARIM.username, password }, remoteAddress: '192.168.1.88' })
    for (let i = 0; i < 4; i++) {
      const wrong = await karim('not-the-password')
      expect(wrong.statusCode).toBe(401)
      expect(body(wrong)).toMatchObject({ error: { code: 'invalid_credentials' } })
    }
    const fifth = await karim('not-the-password')
    expect(fifth.statusCode).toBe(429)
    expect(body(fifth)).toMatchObject({ error: { code: 'locked', params: { until: expect.any(String) } } })
    const sixth = await karim(KARIM.password)
    expect(sixth.statusCode).toBe(429)
    expect(body(sixth)).toMatchObject({ error: { code: 'locked' } })
    expect(sixth.cookies).toHaveLength(0)
  })

  it('blocks a client that guesses unknown usernames', async () => {
    const guess = (username: string) => h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'whatever-it-is' }, remoteAddress: '192.168.1.99' })
    for (let i = 0; i < 4; i++) expect((await guess(`nobody${i}`)).statusCode).toBe(401)
    expect((await guess('nobody4')).statusCode).toBe(429)
    expect(body(await guess('karim'))).toMatchObject({ error: { code: 'locked' } })
  })

  it('refuses a malformed login body', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 1 } })
    expect(response.statusCode).toBe(400)
    expect(body(response)).toMatchObject({ error: { code: 'invalid_input' } })
  })
})
