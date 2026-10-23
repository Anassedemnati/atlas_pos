import type { FastifyInstance } from 'fastify'
import { call, ok, route, type Env } from './shared'

type Body = Record<string, unknown>
const bodyOf = (request: { body: unknown }): Body => (request.body && typeof request.body === 'object' ? (request.body as Body) : {})
const paramId = (request: { params: unknown }): string => (request.params as { id: string }).id

/** Staff accounts and permission profiles. Password at least 8 characters, PIN 4 to 6 digits: the use case enforces both. */
export function registerUsersRoutes(app: FastifyInstance, env: Env): void {
  app.get('/api/users', route(env, (request) => call(env, request, 'users.list', {})))
  app.post('/api/users', route(env, (request) => call(env, request, 'users.saveUser', bodyOf(request) as never)))
  app.put('/api/users/:id', route(env, (request) => call(env, request, 'users.saveUser', { ...bodyOf(request), id: paramId(request) } as never)))

  app.get(
    '/api/profiles',
    route(env, async (request) => {
      const staff = await call(env, request, 'users.list', {})
      return staff.ok ? ok(staff.value.profiles) : staff
    })
  )
  app.post('/api/profiles', route(env, (request) => call(env, request, 'users.saveProfile', bodyOf(request) as never)))
  app.put('/api/profiles/:id', route(env, (request) => call(env, request, 'users.saveProfile', { ...bodyOf(request), id: paramId(request) } as never)))
}
