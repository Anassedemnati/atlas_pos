import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CHANNELS, EVENT_TYPES } from '../../src/shared/ipc/channels'
import { IpcContract, type Channel } from '../../src/shared/ipc-contract'
import { AppErrorException } from '../../src/main/application/errors'
import type { Runtime } from '../../src/main/composition/runtime'
import type { Services } from '../../src/main/composition/services'
import type { Session } from '../../src/main/domain/users/session'
import type { ShellPorts } from '../../src/main/interfaces/ipc/context'
import { allHandlers, dispatch, register, type IpcMainLike } from '../../src/main/interfaces/ipc/register'
import { createSessionStore, type SessionStore } from '../../src/main/interfaces/ipc/session-store'
import type { Logger } from '../../src/main/logger'
import type { DataPaths } from '../../src/main/paths'

const channels = Object.keys(IpcContract) as Channel[]

describe('IPC contract', () => {
  it('gives every channel an `area.verb` name, a zod input schema and an access rule', () => {
    expect(channels.length).toBeGreaterThan(60)
    for (const channel of channels) {
      const def = IpcContract[channel]
      expect(channel, channel).toMatch(/^[a-z]+\.[a-z][A-Za-z]*$/)
      expect(def.input, channel).toBeInstanceOf(z.ZodType)
      const auth = def.auth as unknown
      const valid = ['public', 'session', 'technician', 'staff', 'handler'].includes(auth as string) || typeof auth === 'object'
      expect(valid, channel).toBe(true)
    }
  })

  it('covers the use cases the brief names', () => {
    for (const channel of [
      'app.startupReport',
      'app.quitToDesktop',
      'hardware.detect',
      'hardware.testPrinter',
      'hardware.openDrawer',
      'display.update',
      'orders.addLine',
      'orders.splitAndClose',
      'tickets.cancel',
      'days.close',
      'catalog.previewImport',
      'backup.restore',
      'settings.set',
      'users.authorizeOverride',
      'system.pickFolder'
    ]) {
      expect(channels).toContain(channel)
    }
  })

  it('lists exactly the contract channels for the preload, and has a handler for each', () => {
    expect([...CHANNELS].sort()).toEqual([...channels].sort())
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length)
    expect(Object.keys(allHandlers).sort()).toEqual([...channels].sort())
    expect(EVENT_TYPES).toContain('display.order')
  })
})

// --- register / dispatch with fakes -------------------------------------------------------------

const PROFILE = { id: 'p1', name: { fr: 'Caissier' }, permissions: ['report.x' as const], maxDiscountBp: 1000 }

function fakeServices(over: Partial<Record<string, unknown>> = {}) {
  const user = { id: 'u1', displayName: 'Sara', lang: 'fr' as const, profileId: 'p1', active: true }
  const sessionOf = (): Session => ({
    userId: 'u1',
    displayName: 'Sara',
    lang: 'fr',
    permissions: new Set(PROFILE.permissions),
    maxDiscountBp: 1000,
    isTechnician: false
  })
  const services = {
    usersRepo: { getUser: (id: string) => (id === user.id ? user : undefined), getProfile: () => PROFILE },
    users: { loginPin: vi.fn(async () => ({ ok: true, value: sessionOf() })), listTillUsers: () => [] },
    orders: { getOrder: vi.fn(() => ({ ok: true, value: { id: 'o1' } })) },
    ...over
  }
  return { services: services as unknown as Services, user }
}

function harness(services: Services | null = fakeServices().services) {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }
  const runtime = {
    services: () => services,
    status: () => ({ report: null, startupError: null, route: '#/login', safeMode: false, ready: services !== null }),
    restore: vi.fn()
  } as unknown as Runtime
  const deps = { paths: { backups: '/nowhere' } as DataPaths, runtime, shell: {} as ShellPorts, log }
  const sessions: SessionStore = createSessionStore()
  const call = (channel: Channel, input: unknown, windowId = 1) => dispatch(channel, windowId, input, deps, sessions)
  return { call, log, sessions, deps }
}

describe('register', () => {
  it('registers one handler per contract channel, keyed on the calling window', async () => {
    const handlers = new Map<string, Parameters<IpcMainLike['handle']>[1]>()
    const { deps, sessions } = harness()
    register({ handle: (channel, listener) => handlers.set(channel, listener) }, deps, sessions)
    expect([...handlers.keys()].sort()).toEqual([...channels].sort())
    const result = await handlers.get('users.current')!({ sender: { id: 7 } }, {})
    expect(result).toEqual({ ok: true, value: null })
  })

  it('refuses an input that does not match the schema with invalid_input, naming the field', async () => {
    const { call } = harness()
    const wrongType = await call('orders.get', { orderId: 42 })
    expect(wrongType).toMatchObject({ ok: false, error: { code: 'invalid_input', messageKey: 'errors.invalid_input', params: { field: 'orderId' } } })
    expect(await call('orders.get', { orderId: 'o1', extra: true })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await call('users.logout', undefined)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('turns an unexpected exception into internal_error and logs it, without throwing', async () => {
    const { services } = fakeServices({
      orders: {
        getOrder: () => {
          throw new TypeError('boom')
        }
      }
    })
    const { call, log, sessions } = harness(services)
    sessions.signIn(1, 'u1')
    const result = await call('orders.get', { orderId: 'o1' })
    expect(result).toEqual({ ok: false, error: { code: 'internal_error', messageKey: 'errors.internal_error' } })
    expect(log.error).toHaveBeenCalledWith('ipc.internal_error', expect.objectContaining({ channel: 'orders.get', message: 'boom' }))
  })

  it('returns a refusal thrown as AppErrorException as that refusal', async () => {
    const { services } = fakeServices({
      orders: {
        getOrder: () => {
          throw new AppErrorException('order_not_found', { orderId: 'o1' })
        }
      }
    })
    const { call, sessions } = harness(services)
    sessions.signIn(1, 'u1')
    expect(await call('orders.get', { orderId: 'o1' })).toEqual({
      ok: false,
      error: { code: 'order_not_found', messageKey: 'errors.order_not_found', params: { orderId: 'o1' } }
    })
  })

  it('keeps sessions per window: a PIN login on one window signs nobody in on another', async () => {
    const { call } = harness()
    const login = await call('users.loginPin', { userId: 'u1', pin: '2345' }, 1)
    expect(login).toMatchObject({ ok: true, value: { userId: 'u1', permissions: ['report.x'], isTechnician: false } })
    expect(await call('users.current', {}, 1)).toMatchObject({ ok: true, value: { userId: 'u1' } })
    expect(await call('users.current', {}, 2)).toEqual({ ok: true, value: null })
    expect(await call('orders.get', { orderId: 'o1' }, 1)).toMatchObject({ ok: true })
    expect(await call('orders.get', { orderId: 'o1' }, 2)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    await call('users.logout', {}, 1)
    expect(await call('orders.get', { orderId: 'o1' }, 1)).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
  })

  it('signs out a user deactivated since the login', async () => {
    const { services, user } = fakeServices()
    const { call } = harness(services)
    await call('users.loginPin', { userId: 'u1', pin: '2345' })
    user.active = false
    expect(await call('orders.get', { orderId: 'o1' })).toMatchObject({ ok: false, error: { code: 'not_signed_in' } })
    user.active = true
    expect(await call('users.current', {})).toEqual({ ok: true, value: null })
  })

  it('checks the access rule before the handler runs', async () => {
    const { services } = fakeServices()
    const { call, sessions } = harness(services)
    sessions.signIn(1, 'u1')
    expect(await call('hardware.detect', {})).toMatchObject({ ok: false, error: { code: 'forbidden', params: { reason: 'technician' } } })
    expect(await call('catalog.previewImport', { bytes: new Uint8Array(1), fileName: 'a.csv' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', params: { permission: 'catalog.manage' } }
    })
    expect(await call('app.quitToDesktop', {})).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('answers app_not_ready for the use cases while no database is open', async () => {
    const { call } = harness(null)
    expect(await call('users.listTill', {})).toMatchObject({ ok: false, error: { code: 'app_not_ready' } })
    expect(await call('orders.get', { orderId: 'o1' })).toMatchObject({ ok: false, error: { code: 'app_not_ready' } })
    expect(await call('users.current', {})).toEqual({ ok: true, value: null })
  })
})
