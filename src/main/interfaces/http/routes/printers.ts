import type { FastifyInstance } from 'fastify'
import { call, ok, route, type Env } from './shared'

const paramId = (request: { params: unknown }): string => (request.params as { id: string }).id

/**
 * The printers, their routing and the print queue, and the test page. Adding or editing a printer is the technician's
 * (the till's technician menu): there is no use case for it over HTTP, where no technician code is ever typed.
 */
export function registerPrintersRoutes(app: FastifyInstance, env: Env): void {
  app.get(
    '/api/printers',
    route(env, async (request) => {
      const printers = await call(env, request, 'printing.printers', {})
      if (!printers.ok) return printers
      const [routing, jobs] = await Promise.all([call(env, request, 'printing.routing', {}), call(env, request, 'printing.jobs', {})])
      return ok({ printers: printers.value, routing: routing.ok ? routing.value : [], jobs: jobs.ok ? jobs.value : [] })
    })
  )
  app.post('/api/printers/:id/test', route(env, (request) => call(env, request, 'hardware.testPrinter', { printerId: paramId(request) })))
  app.post('/api/printers/jobs/:id/reprint', route(env, (request) => call(env, request, 'printing.reprintJob', { jobId: paramId(request) })))
  app.post('/api/printers/jobs/:id/dismiss', route(env, (request) => call(env, request, 'printing.dismissJob', { jobId: paramId(request) })))
}
