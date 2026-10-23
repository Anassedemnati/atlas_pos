import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { configChannels } from '@shared/ipc/config'
import type { setupChannels, techChannels } from '@shared/ipc/setup'
import { AppErrorException } from '../../application/errors'
import { listFloor, listPaymentMethods, listRouting, listStaff } from '../../application/usecases/config/lists'
import { applyChanges, exportCurrentProfile, importProfile, readLogs, type TechDeps } from '../../application/usecases/setup/technician'
import { refuse } from '../../application/usecases/users/outcome'
import { appHandlers } from './app'
import { ok, requireSetupMode, type CallContext, type Handlers, type IpcDeps } from './context'
import { systemHandlers } from './system'

type SetupChannel = keyof typeof setupChannels | keyof typeof techChannels | keyof typeof configChannels

const MB = 1024 * 1024
const LIMITS = { profile: 32 * MB, sheet: 5 * MB, logo: 2 * MB }

/** A file by path (read here, up to `limit` bytes) or the bytes the renderer sent. */
function readSource(
  input: { path?: string | undefined; bytes?: Uint8Array | undefined; fileName?: string | undefined },
  limit: number,
  needsName = false
): { buf: Buffer; fileName: string } {
  if (input.path !== undefined) {
    let size: number
    try {
      size = statSync(input.path).size
    } catch {
      throw new AppErrorException('invalid_input', { field: 'path', reason: 'unreadable' })
    }
    if (size > limit) throw new AppErrorException('invalid_input', { field: 'path', reason: 'too large' })
    return { buf: readFileSync(input.path), fileName: basename(input.path) }
  }
  const bytes = input.bytes!
  if (bytes.byteLength > limit) throw new AppErrorException('invalid_input', { field: 'bytes', reason: 'too large' })
  if (needsName && !input.fileName) throw new AppErrorException('invalid_input', { field: 'fileName', reason: 'required' })
  return { buf: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), fileName: input.fileName ?? 'file' }
}

const techDeps = (ctx: CallContext, deps: IpcDeps): TechDeps => {
  const { db, uow, settings, backup } = ctx.services()
  return { db, uow, settings, backup, paths: deps.paths, clock: deps.clock ?? { now: () => new Date() }, appVersion: deps.shell.appVersion }
}

/** A folder the wizard may read backups from: one chosen with `system.pickFolder` on this window. */
function requirePickedFolder(ctx: CallContext, folder: string): void {
  if (!ctx.sessions.hasFolder(ctx.windowId, folder)) throw new AppErrorException('forbidden', { reason: 'folder_not_picked' })
}

/** The setup wizard, the technician menu and the lists of what the setup created. */
export const setupHandlers: Handlers<SetupChannel> = {
  'setup.templates': (_input, ctx, deps) => (requireSetupMode(ctx, deps), ok(deps.setup.templates())),
  'setup.getDraft': (_input, ctx, deps) => (requireSetupMode(ctx, deps), ok(deps.setup.getDraft())),
  'setup.saveDraft': ({ patch, validateStep }, ctx, deps) => (requireSetupMode(ctx, deps), deps.setup.saveDraft(patch, validateStep)),
  'setup.resetDraft': (_input, ctx, deps) => (requireSetupMode(ctx, deps), ok(deps.setup.resetDraft())),
  'setup.detectHardware': async (_input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    return ok(await deps.shell.detectHardware())
  },
  'setup.testPrinter': async ({ printer, action }, ctx, deps) => {
    requireSetupMode(ctx, deps)
    return deps.setup.testPrinter(printer, action)
  },
  'setup.testBackupTarget': async (input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    return deps.setup.testBackupTarget(input)
  },
  'setup.previewImport': (input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    const { buf, fileName } = readSource(input, LIMITS.sheet, true)
    return ok(deps.setup.previewImport(buf, fileName))
  },
  'setup.pickLogo': (input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    const { buf, fileName } = readSource(input, LIMITS.logo, true)
    return deps.setup.pickLogo(buf, fileName)
  },
  'setup.applyProfile': (input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    return deps.setup.applyProfileToDraft(readSource(input, LIMITS.profile).buf)
  },
  'setup.finish': async (_input, ctx, deps) => {
    requireSetupMode(ctx, deps)
    const finished = await deps.setup.finishSetup()
    if (!finished.ok) return finished
    // The installation is complete: open the services on it, no restart.
    deps.runtime.reopen()
    const status = deps.runtime.status()
    if (!status.ready) {
      deps.log.error('setup.open_failed', { startupError: status.startupError, state: status.report?.state ?? null })
      return refuse('setup_failed', { stage: 'open', message: status.startupError ?? status.report?.state ?? 'unknown' })
    }
    deps.shell.afterSetup()
    return ok({ installationId: finished.value.installationId, route: status.route, warnings: finished.value.warnings })
  },
  'setup.openTill': (_input, ctx, deps) => {
    // For the person who just set up the till (nobody is signed in yet): not a way to sign a user out.
    if (ctx.optionalSession()) throw new AppErrorException('forbidden', { reason: 'signed_in' })
    const status = deps.runtime.status()
    if (!status.ready) return refuse('app_not_ready')
    deps.shell.navigateTill(status.route)
    return ok(true as const)
  },
  'setup.listBackupsAt': async ({ folder }, ctx, deps) => {
    requireSetupMode(ctx, deps)
    requirePickedFolder(ctx, folder)
    return ok(await deps.setup.listBackupsAt(folder))
  },
  'setup.restoreFrom': async ({ file, folder }, ctx, deps) => {
    requireSetupMode(ctx, deps)
    requirePickedFolder(ctx, folder)
    deps.log.info('setup.restore_requested', { file, folder })
    const result = await deps.setup.restoreFrom(file, folder)
    if (!result.ok) return result
    ctx.sessions.clear()
    deps.shell.afterSetup()
    return result
  },

  'tech.applyChanges': ({ patch }, ctx, deps) => applyChanges(techDeps(ctx, deps), patch),
  'tech.exportProfile': (_input, ctx, deps) => ok(exportCurrentProfile(techDeps(ctx, deps))),
  'tech.importProfile': ({ replaceCatalog, ...file }, ctx, deps) => {
    const { buf } = readSource(file, LIMITS.profile)
    return importProfile(techDeps(ctx, deps), buf, { replaceCatalog })
  },
  'tech.logs': ({ tail }, _ctx, deps) => ok(readLogs(deps.paths, tail ?? 200)),
  // The technician mode already passes both: the same restore and quit as the backup and app channels.
  'tech.restore': (input, ctx, deps) => systemHandlers['backup.restore'](input, ctx, deps),
  'tech.quitToDesktop': (input, ctx, deps) => appHandlers['app.quitToDesktop'](input, ctx, deps),

  'floor.list': (_input, ctx) => ok(listFloor(ctx.services().db)),
  'payments.list': (_input, ctx) => ok(listPaymentMethods(ctx.services().db)),
  'printing.routing': (_input, ctx) => ok(listRouting(ctx.services().db)),
  'users.list': (_input, ctx) => ok(listStaff(ctx.services().db))
}
