import type { HardwareDto, OrderDto } from '@shared/dto'
import type { Channel, Out, Parsed } from '@shared/ipc-contract'
import type { Result } from '@shared/result'
import { AppErrorException } from '../../application/errors'
import type { Clock } from '../../application/ports'
import type { SetupService } from '../../application/usecases/setup'
import type { OverrideToken, Session } from '../../domain/users/session'
import type { Runtime } from '../../composition/runtime'
import type { Services } from '../../composition/services'
import type { Logger } from '../../logger'
import type { DataPaths } from '../../paths'
import type { SessionStore } from './session-store'

/** What the handlers need from Electron, injected so that they can be tested without it. */
export interface ShellPorts {
  appVersion: string
  /** The system folder dialog on the window, null when cancelled. */
  pickFolder(windowId: number, title?: string): Promise<string | null>
  pickFile(windowId: number, options: { title?: string; extensions?: string[] }): Promise<string | null>
  /** Ends the application for good (the watchdog does not restart a clean exit). */
  quitToDesktop(): void
  /** Quits so that the watchdog starts the application again normally (out of safe mode). */
  restartNormally(): void
  detectHardware(): Promise<HardwareDto>
  /** Sends the order to the customer display, if there is one. */
  showOnDisplay(order: OrderDto | null): void
  /** Reloads the till window on a route (after a restore). */
  navigateTill(route: string): void
  /**
   * The database has just been created (the setup finished) or restored onto a new installation: starts what
   * depends on its settings (kiosk mode, customer display, back office, auto-start). The till window stays put.
   */
  afterSetup(): void
}

export interface IpcDeps {
  paths: DataPaths
  runtime: Pick<Runtime, 'status' | 'services' | 'restore' | 'reopen'>
  /** The setup wizard's back end: used only while no installation exists. */
  setup: SetupService
  shell: ShellPorts
  log: Logger
  /** The system clock unless a test sets one. */
  clock?: Clock
  /** Written synchronously to `logs/fatal.log`: what must survive the next crash (a restore nobody signed in for). */
  durableLog?: (event: string, data?: Record<string, unknown>) => void
}

/** One call, from one window. */
export interface CallContext {
  windowId: number
  sessions: SessionStore
  /** The use cases; `app_not_ready` while no database is open (setup, corrupt, newer schema). */
  services(): Services
  /** The signed-in session, read again from the database; `not_signed_in` otherwise. */
  session(): Session
  /** The session, or null when nobody is signed in on this window (or no database is open). */
  optionalSession(): Session | null
  /** No database is open: setup, corrupt or newer database, or a start-up failure. */
  noDatabase(): boolean
}

export type Handler<C extends Channel> = (
  input: Parsed<C>,
  ctx: CallContext,
  deps: IpcDeps
) => Result<Out<C>> | Promise<Result<Out<C>>>

/** The handlers of an area: one per channel of `K`, so a missing one does not compile. */
export type Handlers<K extends Channel> = { [C in K]: Handler<C> }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

/**
 * The approval a manager gave, from the `id` the renderer holds. The override registry reads the id
 * only and trusts what it recorded when it issued it (who approved, for what, until when); the other
 * fields of this object are never read.
 */
export function overrideToken(id: string | undefined): OverrideToken | undefined {
  return id === undefined ? undefined : { id, byUserId: '', permission: 'order.discount', expiresAt: '' }
}

/**
 * The rule of the system dialogs: a signed-in user or the technician mode, or no database open at all
 * (the setup wizard and the recovery screen have nobody to sign in).
 */
export function requireUserOrNoDatabase(ctx: CallContext): void {
  if (ctx.noDatabase() || ctx.sessions.isTechnician(ctx.windowId)) return
  ctx.session()
}

/** The technician mode, or no database open (nobody can sign in there). */
export function requireTechnicianOrNoDatabase(ctx: CallContext): void {
  if (ctx.noDatabase() || ctx.sessions.isTechnician(ctx.windowId)) return
  throw new AppErrorException('forbidden', { reason: 'technician' })
}

export function createCallContext(windowId: number, sessions: SessionStore, deps: IpcDeps): CallContext {
  let cached: Session | null | undefined
  const services = (): Services => {
    const current = deps.runtime.services()
    if (!current) throw new AppErrorException('app_not_ready')
    return current
  }
  const optionalSession = (): Session | null => {
    if (cached === undefined) {
      const current = deps.runtime.services()
      cached = current ? sessions.session(windowId, current.usersRepo) : null
    }
    return cached
  }
  return {
    windowId,
    sessions,
    services,
    optionalSession,
    noDatabase: () => deps.runtime.services() === null,
    session() {
      services()
      const session = optionalSession()
      if (!session) throw new AppErrorException('not_signed_in')
      return session
    }
  }
}

/**
 * The setup channels work only while the application waits for its setup: no database open AND the start-up
 * check said `needs-setup` (a corrupt or newer database also has none open, and must never be set up over).
 */
export function requireSetupMode(ctx: CallContext, deps: Pick<IpcDeps, 'runtime'>): void {
  if (!ctx.noDatabase() || deps.runtime.status().report?.state !== 'needs-setup') {
    throw new AppErrorException('forbidden', { reason: 'setup_complete' })
  }
}
