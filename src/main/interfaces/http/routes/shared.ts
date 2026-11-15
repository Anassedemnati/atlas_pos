import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Channel, In, Out } from '@shared/ipc-contract'
import type { AppError, Result } from '@shared/result'
import { AppErrorException } from '../../../application/errors'
import type { Clock } from '../../../application/ports'
import { refuse } from '../../../application/usecases/users/outcome'
import type { Session } from '../../../domain/users/session'
import type { Runtime } from '../../../composition/runtime'
import type { Services } from '../../../composition/services'
import type { Logger } from '../../../logger'
import { describeError } from '../../../logger'
import type { DataPaths } from '../../../paths'
import type { IpcDeps } from '../../ipc/context'
import { dispatch } from '../../ipc/register'
import type { SessionStore } from '../../ipc/session-store'
import type { HttpSession, HttpSessions } from '../auth'

/** What the application gives the back office: the use cases (read on every request), the data folders, the till. */
export interface HttpDeps {
  /** `services()` is read on each request: it is null while a restore runs and the services are rebuilt after it. */
  runtime: Pick<Runtime, 'status' | 'services' | 'restore' | 'reopen'>
  paths: DataPaths
  log: Logger
  appVersion?: string
  clock?: Clock
  /** A restore replaced the database: the till window must reload on this route. */
  afterRestore?(route: string): void
  /** A restore in safe mode: start again normally. */
  restartNormally?(): void
}

/** What a route needs; built once by `createHttpServer`. */
export interface Env {
  deps: HttpDeps
  /** The IPC layer's own dependencies: the HTTP routes go through the same validation and permission rules as the till. */
  ipc: IpcDeps
  ipcSessions: SessionStore
  sessions: HttpSessions
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The back office session of the request (set on every route that needs a sign-in). */
    bo: HttpSession
  }
}

/** The HTTP status of a refusal. */
const STATUS: Record<string, number> = {
  invalid_input: 400,
  invalid_pin_format: 400,
  confirmation_required: 400,
  not_signed_in: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  backup_not_found: 404,
  locked: 429,
  import_too_large: 413,
  upload_too_large: 413,
  unsupported_media: 415,
  app_not_ready: 503,
  internal_error: 500
}

/** Any `invalid_*` is a request that is wrong (400); the other business refusals (`barcode_taken`, `last_manager`...) conflict with the state (409). */
export const statusOf = (error: AppError): number => STATUS[error.code] ?? (error.code.startsWith('invalid_') ? 400 : 409)

/** Sends a `Result`: 200 with `{ ok: true, value }`, or the refusal with its status and `{ ok: false, error }`. */
export function sendResult<T>(reply: FastifyReply, result: Result<T>): FastifyReply {
  return result.ok ? reply.code(200).send(result) : reply.code(statusOf(result.error)).send(result)
}

/** A refusal as a `Result`. */
export const refused = (code: string, params?: Record<string, unknown>): Result<never> => refuse(code, params)

/** Calls an IPC channel as the signed-in user of the request: same validation, same permission check, same use case. */
export function call<C extends Channel>(env: Env, request: FastifyRequest, channel: C, input: In<C>): Promise<Result<Out<C>>> {
  return dispatch(channel, request.bo.windowId, input, env.ipc, env.ipcSessions) as Promise<Result<Out<C>>>
}

export interface Acting {
  services: Services
  session: Session
}

/** The open database's use cases and the user's session as it is now. Throws the refusal otherwise. */
export function acting(env: Env, request: FastifyRequest): Acting {
  const services = env.deps.runtime.services()
  if (!services) throw new AppErrorException('app_not_ready')
  const session = env.ipcSessions.session(request.bo.windowId, services.usersRepo)
  if (!session) throw new AppErrorException('not_signed_in')
  return { services, session }
}

/**
 * Runs a route body that returns a `Result` (or throws a refusal) and sends it. Anything else thrown is a bug: it is
 * logged and answered with `internal_error`, and the server carries on.
 */
export function route<T>(env: Env, body: (request: FastifyRequest, reply: FastifyReply) => Promise<Result<T>> | Result<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      return sendResult(reply, await body(request, reply))
    } catch (error) {
      if (error instanceof AppErrorException) return sendResult(reply, refuse(error.code, error.params))
      env.deps.log.error('http.internal_error', { url: request.url.split('?')[0], ...describeError(error) })
      return sendResult(reply, refuse('internal_error'))
    }
  }
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

/** Query values arrive as strings (or arrays when repeated): the first string, or undefined. */
export function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : undefined
}
