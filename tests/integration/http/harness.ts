import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { vi } from 'vitest'
import type { DomainEvent } from '../../../src/main/application/events'
import { createEventBus } from '../../../src/main/application/events'
import { createRuntime, type Runtime } from '../../../src/main/composition/runtime'
import { createHttpServer } from '../../../src/main/interfaces/http/server'
import { ensureDataLayout, type DataPaths } from '../../../src/main/paths'
import type { Session } from '../../../src/main/domain/users/session'
import { completeDraft, log, MANAGER_PASSWORD, MANAGER_PIN, testSetupService } from '../../helpers/setup'

export const KARIM = { username: 'karim', password: MANAGER_PASSWORD, pin: MANAGER_PIN }
export const YOUSSEF = { username: 'youssef', password: 'Serveur-Pass-2026', pin: '3333' }

export interface Http {
  app: FastifyInstance
  runtime: Runtime
  paths: DataPaths
  root: string
  events: DomainEvent[]
  afterRestore: ReturnType<typeof vi.fn>
  /** The manager's cookie and CSRF token once `login()` ran. */
  cookie: string
  csrf: string
  login(user?: { username: string; password: string }, remoteAddress?: string): Promise<LightMyRequestResponse>
  /** A request as the signed-in manager (CSRF token included on anything that changes). */
  api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<LightMyRequestResponse>
  /** A request with a raw body (a sheet, a photo). */
  upload(url: string, bytes: Uint8Array, headers?: Record<string, string>): Promise<LightMyRequestResponse>
  /** Karim's till session, to make sales through the use cases. */
  till(): Promise<Session>
  close(): Promise<void>
}

/** A finished installation (Karim the manager, Sara the cashier, Youssef the waiter), the whole runtime, and the HTTP server on it (never listening: `inject`). */
export async function startHttp(): Promise<Http> {
  const root = mkdtempSync(join(tmpdir(), 'atlas-http-'))
  const paths = ensureDataLayout(join(root, 'data'))
  const backupDir = join(root, 'disk2')
  mkdirSync(backupDir)
  const staticDir = join(root, 'renderer')
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  writeFileSync(join(staticDir, 'backoffice.html'), '<!doctype html><title>Atlas POS</title>')
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')

  const logger = log()
  const bus = createEventBus()
  const events: DomainEvent[] = []
  for (const type of ['catalog.changed', 'settings.changed', 'ticket.closed', 'day.closed'] as const) bus.subscribe(type, (event) => events.push(event))
  const runtime = createRuntime({
    paths,
    clock: { now: () => new Date() },
    bus,
    log: logger,
    appVersion: '0.1.0',
    rasterize: async () => {
      throw new Error('no rendering in tests')
    },
    unclean: false,
    safeMode: false
  })
  runtime.boot()
  const setup = testSetupService({ paths, log: logger, bus, restore: (file) => runtime.restore(file) })
  const draft = completeDraft(
    { paths, backupDir, root, cleanup() {} },
    {
      users: [
        { displayName: 'Karim', pin: KARIM.pin, profileCode: 'gerant', username: KARIM.username, password: KARIM.password },
        { displayName: 'Sara', pin: '2345', profileCode: 'caissier' },
        { displayName: 'Youssef', pin: YOUSSEF.pin, profileCode: 'serveur', username: YOUSSEF.username, password: YOUSSEF.password }
      ]
    }
  )
  const saved = setup.saveDraft(draft)
  if (!saved.ok) throw new Error(`saveDraft: ${JSON.stringify(saved.error)}`)
  const finished = await setup.finishSetup()
  if (!finished.ok) throw new Error(`finish: ${JSON.stringify(finished.error)}`)
  runtime.reopen()

  const afterRestore = vi.fn()
  const app = createHttpServer(
    { runtime, paths, log: logger, appVersion: '0.1.0', afterRestore, restartNormally: vi.fn() },
    { port: 0, staticDir }
  )
  await app.ready()

  const http: Http = {
    app,
    runtime,
    paths,
    root,
    events,
    afterRestore,
    cookie: '',
    csrf: '',
    async login(user = KARIM, remoteAddress = '127.0.0.1') {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: user.password }, remoteAddress })
      if (response.statusCode === 200 && (user === KARIM || user.username === KARIM.username)) {
        http.cookie = String(response.cookies[0]?.name) + '=' + String(response.cookies[0]?.value)
        http.csrf = (response.json() as { value: { csrfToken: string } }).value.csrfToken
      }
      return response
    },
    api: (method, url, body) =>
      app.inject({
        method,
        url,
        headers: { cookie: http.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': http.csrf }) },
        ...(body === undefined ? {} : { payload: body as object })
      }),
    upload: (url, bytes, headers = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie: http.cookie, 'x-csrf-token': http.csrf, 'content-type': 'application/octet-stream', ...headers },
        payload: Buffer.from(bytes)
      }),
    async till() {
      const services = runtime.services()!
      const id = services.users.listTillUsers().find((user) => user.displayName === 'Karim')!.id
      const result = await services.users.loginPin(id, KARIM.pin)
      if (!result.ok) throw new Error('till login failed')
      return result.value
    },
    async close() {
      await app.close()
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }
  return http
}

export const body = <T = Record<string, unknown>>(response: LightMyRequestResponse): T => response.json() as T
