import { createReadStream } from 'node:fs'
import type { BackupEntryDto } from '@shared/dto'
import type { FastifyInstance } from 'fastify'
import { AppErrorException } from '../../../application/errors'
import { requirePermission } from '../../../domain/users/session'
import { manifestPath } from '../../../infrastructure/backup/snapshot'
import { acting, call, ok, queryText, refused, route, sendResult, type Env } from './shared'

/** The word a person types to confirm a restore. */
export const RESTORE_CONFIRMATION = 'RESTAURER'

type Body = Record<string, unknown>

/**
 * A backup is named by what the listing says about it (its destination and file name), never by a path the browser
 * sends: the id is looked up again in the listing before anything is read or restored.
 */
const idOf = (entry: BackupEntryDto): string => Buffer.from(`${entry.source}\n${entry.fileName}`).toString('base64url')

/** The status of each destination, the backups found, a manual backup, the download, and the restore. */
export function registerBackupsRoutes(app: FastifyInstance, env: Env): void {
  /** The entry an id names, with the path (which never leaves this file). */
  async function find(request: Parameters<typeof call>[1], id: string): Promise<BackupEntryDto | null> {
    const listed = await call(env, request, 'backup.list', {})
    if (!listed.ok) throw new AppErrorException(listed.error.code, listed.error.params)
    return listed.value.find((entry) => idOf(entry) === id) ?? null
  }

  app.get(
    '/api/backups',
    route(env, async (request) => {
      const { session } = acting(env, request)
      requirePermission(session, 'settings.manage')
      const [status, listed] = await Promise.all([call(env, request, 'backup.status', {}), call(env, request, 'backup.list', {})])
      if (!status.ok) return status
      if (!listed.ok) return listed
      // `file` is a path on this machine: the browser gets an id instead.
      const entries = listed.value.map(({ file: _file, ...entry }) => ({ ...entry, id: idOf({ ...entry, file: _file }) }))
      return ok({ status: status.value, entries })
    })
  )

  app.post('/api/backups/run', route(env, (request) => call(env, request, 'backup.run', {})))

  app.post(
    '/api/backups/restore',
    route(env, async (request) => {
      const { session } = acting(env, request)
      requirePermission(session, 'backup.restore')
      const body = (request.body ?? {}) as Body
      if (body['confirm'] !== RESTORE_CONFIRMATION) return refused('confirmation_required', { expected: RESTORE_CONFIRMATION })
      if (typeof body['id'] !== 'string') return refused('invalid_input', { field: 'id' })
      const entry = await find(request, body['id'])
      if (!entry) return refused('backup_not_found')
      const result = await call(env, request, 'backup.restore', { file: entry.file })
      // The users and their rights are the backup's now: every browser signs in again.
      if (result.ok) env.sessions.clear()
      return result
    })
  )

  app.get('/api/backups/:id/download', async (request, reply) => {
    try {
      const { session } = acting(env, request)
      // A backup holds every record and every password hash of the business.
      requirePermission(session, 'backup.restore')
      const entry = await find(request, (request.params as { id: string }).id)
      if (!entry) return sendResult(reply, refused('backup_not_found'))
      const part = queryText((request.query as Body)['part'])
      const file = part === 'manifest' ? manifestPath(entry.file) : entry.file
      const name = part === 'manifest' ? `${entry.fileName}.json` : entry.fileName
      return reply
        .header('content-type', part === 'manifest' ? 'application/json' : 'application/gzip')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(createReadStream(file))
    } catch (error) {
      if (error instanceof AppErrorException) return sendResult(reply, { ok: false, error })
      throw error
    }
  })
}
