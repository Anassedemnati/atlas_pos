import type { ChannelAuth } from '@shared/ipc/define'
import { IpcContract, type Channel } from '@shared/ipc-contract'
import type { Result } from '@shared/result'
import { AppErrorException } from '../../application/errors'
import { refuse } from '../../application/usecases/users/outcome'
import { requirePermission } from '../../domain/users/session'
import { describeError } from '../../logger'
import { appHandlers } from './app'
import { catalogHandlers } from './catalog'
import { createCallContext, type CallContext, type Handler, type Handlers, type IpcDeps } from './context'
import { ordersHandlers } from './orders'
import { salesHandlers } from './sales'
import type { SessionStore } from './session-store'
import { setupHandlers } from './setup'
import { systemHandlers } from './system'
import { usersHandlers } from './users'

/** The part of Electron's `ipcMain` this needs (a fake in tests). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: { sender: { id: number } }, input: unknown) => Promise<unknown>): void
}

/** Every channel's handler; the type makes a channel without a handler a compile error. */
export const allHandlers: Handlers<Channel> = {
  ...appHandlers,
  ...usersHandlers,
  ...catalogHandlers,
  ...ordersHandlers,
  ...salesHandlers,
  ...systemHandlers,
  ...setupHandlers
}

function authorize(auth: ChannelAuth, ctx: CallContext): void {
  if (auth === 'public' || auth === 'handler') return
  const technician = ctx.sessions.isTechnician(ctx.windowId)
  if (auth === 'technician') {
    if (!technician) throw new AppErrorException('forbidden', { reason: 'technician' })
    return
  }
  if ((auth === 'staff' || (typeof auth === 'object' && auth.orTechnician)) && technician) return
  const session = ctx.session()
  if (typeof auth === 'object') requirePermission(session, auth.permission)
}

/**
 * Handles one call: validates the input against the contract (`invalid_input`, `params.field` = the
 * path of the first problem), checks who may call it, and runs the handler. A refusal a use case
 * throws (`AppErrorException`) is returned as such; anything else is a bug: it is logged and answered
 * with `internal_error`, and the main process carries on.
 */
export async function dispatch(
  channel: Channel,
  windowId: number,
  raw: unknown,
  deps: IpcDeps,
  sessions: SessionStore,
  handlers: Handlers<Channel> = allHandlers
): Promise<Result<unknown>> {
  try {
    const parsed = IpcContract[channel].input.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return refuse('invalid_input', { field: issue?.path.join('.') ?? '', reason: issue?.message ?? 'invalid' })
    }
    const ctx = createCallContext(windowId, sessions, deps)
    authorize(IpcContract[channel].auth, ctx)
    const handler = handlers[channel] as Handler<Channel>
    return await handler(parsed.data as never, ctx, deps)
  } catch (error) {
    if (error instanceof AppErrorException) return refuse(error.code, error.params)
    deps.log.error('ipc.internal_error', { channel, ...describeError(error) })
    return refuse('internal_error')
  }
}

/** Registers every contract channel on `ipcMain`. Sessions are per calling window (`webContents.id`). */
export function register(
  ipcMain: IpcMainLike,
  deps: IpcDeps,
  sessions: SessionStore,
  handlers: Handlers<Channel> = allHandlers
): void {
  for (const channel of Object.keys(IpcContract) as Channel[]) {
    ipcMain.handle(channel, (event, input) => dispatch(channel, event.sender.id, input, deps, sessions, handlers))
  }
}
