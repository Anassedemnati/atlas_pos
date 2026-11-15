import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { MEDIA_DIR_NAME } from '@shared/media'
import { requirePermission } from '../../../domain/users/session'
import { MAX_IMPORT_BYTES } from '../../../infrastructure/import/catalog-sheet'
import { writeFileAtomic } from '../../../infrastructure/fs/atomic'
import { serveMedia } from '../../../infrastructure/fs/media-files'
import { AppErrorException } from '../../../application/errors'
import { MEDIA_HOST, MEDIA_SCHEME } from '@shared/media'
import { newPreviewId } from '../auth'
import { acting, call, ok, queryText, refused, route, sendResult, type Env } from './shared'

/** The biggest product photo accepted: a phone picture is smaller once the till shows it as a key. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024

type Body = Record<string, unknown>
const bodyOf = (request: { body: unknown }): Body => (request.body && typeof request.body === 'object' ? (request.body as Body) : {})
const paramId = (request: { params: unknown }): string => (request.params as { id: string }).id

/** The kind of image from its first bytes (never from the file name or the content type the browser sent), or null. */
export function imageKind(bytes: Uint8Array): { ext: string; type: string } | null {
  const at = (index: number): number => bytes[index] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return { ext: 'png', type: 'image/png' }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ext: 'jpg', type: 'image/jpeg' }
  const ascii = (from: number, to: number): string => Buffer.from(bytes.subarray(from, to)).toString('latin1')
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' }
  return null
}

/** The catalogue: products, categories, modifier groups, set menus, order of the keys, stock, import / export, photos. */
export function registerCatalogRoutes(app: FastifyInstance, env: Env): void {
  const { paths } = env.deps

  app.get('/api/catalog', route(env, (request) => call(env, request, 'catalog.list', {})))

  // Products and categories. The id of the URL wins over one in the body.
  app.post('/api/catalog/products', route(env, (request) => call(env, request, 'catalog.saveProduct', bodyOf(request) as never)))
  app.put('/api/catalog/products/:id', route(env, (request) => call(env, request, 'catalog.saveProduct', { ...bodyOf(request), id: paramId(request) } as never)))
  app.delete('/api/catalog/products/:id', route(env, (request) => call(env, request, 'catalog.deleteProduct', { id: paramId(request) })))
  app.post('/api/catalog/categories', route(env, (request) => call(env, request, 'catalog.saveCategory', bodyOf(request) as never)))
  app.put('/api/catalog/categories/:id', route(env, (request) => call(env, request, 'catalog.saveCategory', { ...bodyOf(request), id: paramId(request) } as never)))
  app.delete('/api/catalog/categories/:id', route(env, (request) => call(env, request, 'catalog.deleteCategory', { id: paramId(request) })))
  app.post('/api/catalog/modifier-groups', route(env, (request) => call(env, request, 'catalog.saveModifierGroup', bodyOf(request) as never)))
  app.put('/api/catalog/modifier-groups/:id', route(env, (request) => call(env, request, 'catalog.saveModifierGroup', { ...bodyOf(request), id: paramId(request) } as never)))
  app.post('/api/catalog/menus', route(env, (request) => call(env, request, 'catalog.saveMenu', bodyOf(request) as never)))
  app.post('/api/catalog/reorder', route(env, (request) => call(env, request, 'catalog.reorder', bodyOf(request) as never)))
  app.post('/api/catalog/stock', route(env, (request) => call(env, request, 'catalog.adjustStock', bodyOf(request) as never)))

  // The sheet. The preview reads the file and keeps the result here; the apply step takes the id of that preview, never
  // rows from the browser, so a sheet with errors can never be applied (`has_errors`).
  app.post(
    '/api/catalog/import/preview',
    { bodyLimit: MAX_IMPORT_BYTES + 1024 },
    route(env, async (request) => {
      const bytes = request.body instanceof Buffer ? request.body : null
      if (!bytes || bytes.length === 0) return refused('invalid_input', { field: 'body', reason: 'a file is expected (application/octet-stream)' })
      const header = request.headers['x-file-name']
      let fileName = ''
      try {
        fileName = decodeURIComponent(typeof header === 'string' ? header : '')
      } catch {
        // an undecodable name is as good as none
      }
      const parsed = await call(env, request, 'catalog.previewImport', { bytes: new Uint8Array(bytes), fileName: fileName || 'import.csv' })
      if (!parsed.ok) return parsed
      const previewId = newPreviewId()
      env.sessions.addPreview(request.bo, previewId, { parsed: parsed.value, fileName })
      return ok({ previewId, rows: parsed.value.rows, errors: parsed.value.errors })
    })
  )
  app.post(
    '/api/catalog/import/apply',
    route(env, async (request) => {
      const body = bodyOf(request)
      const preview = typeof body['previewId'] === 'string' ? request.bo.previews.get(body['previewId']) : undefined
      if (!preview) return refused('invalid_input', { field: 'previewId', reason: 'unknown preview' })
      if (preview.parsed.errors.length > 0) return refused('has_errors', { errors: preview.parsed.errors.length })
      const result = await call(env, request, 'catalog.applyImport', { rows: preview.parsed.rows, mode: body['mode'] as 'merge' | 'replace' })
      if (result.ok && typeof body['previewId'] === 'string') request.bo.previews.delete(body['previewId'])
      return result
    })
  )
  app.get('/api/catalog/export', async (request, reply) => {
    const format = queryText((request.query as Body)['format']) ?? 'xlsx'
    const result = await call(env, request, 'catalog.exportSheet', { format: format as 'xlsx' | 'csv' })
    if (!result.ok) return sendResult(reply, result)
    const type = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    return reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${result.value.fileName}"`)
      .send(Buffer.from(result.value.bytes))
  })

  // Photos: stored as `media/products/<uuid>.<ext>`; the product is then saved with that `imagePath`.
  app.post(
    '/api/media/products',
    { bodyLimit: MAX_PHOTO_BYTES + 1024 },
    route(env, (request) => {
      const { session } = acting(env, request)
      requirePermission(session, 'catalog.manage')
      const bytes = request.body instanceof Buffer ? request.body : null
      if (!bytes || bytes.length === 0) throw new AppErrorException('invalid_input', { field: 'body' })
      if (bytes.length > MAX_PHOTO_BYTES) throw new AppErrorException('upload_too_large', { maxBytes: MAX_PHOTO_BYTES })
      const kind = imageKind(bytes)
      if (!kind) throw new AppErrorException('unsupported_media', { allowed: ['png', 'jpg', 'webp'] })
      const dir = join(paths.media, 'products')
      mkdirSync(dir, { recursive: true })
      const name = `${randomUUID()}.${kind.ext}`
      writeFileAtomic(join(dir, name), bytes)
      return ok({ imagePath: `${MEDIA_DIR_NAME}/products/${name}` })
    })
  )

  // The same files the till shows, for a browser (`atlas-media://` only exists inside the till window).
  app.get('/media/*', async (request, reply) => {
    const rest = (request.params as { '*': string })['*']
    const response = await serveMedia(paths.media, { url: `${MEDIA_SCHEME}://${MEDIA_HOST}/${rest}`, method: request.method })
    for (const [name, value] of response.headers) void reply.header(name, value)
    return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()))
  })
}
