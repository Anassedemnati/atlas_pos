import type { BackupEntryDto, PrinterDto } from '@shared/dto'
import type { backupChannels, printingChannels, settingsChannels } from '@shared/ipc/system'
import { AppErrorException } from '../../application/errors'
import { refuse } from '../../application/usecases/users/outcome'
import { SETTINGS, isSettingKey, type SettingKey, type SettingsValues } from '../../domain/config/settings-registry'
import { requirePermission } from '../../domain/users/session'
import { listBackups, type BackupEntry } from '../../infrastructure/backup/restore'
import type { BackupTarget } from '../../infrastructure/backup/targets'
import { appendEvent } from '../../infrastructure/db/event-log'
import { readPrinter } from '../../infrastructure/printing/router'
import { ok, type CallContext, type Handlers, type IpcDeps } from './context'

type SystemChannel = keyof typeof settingsChannels | keyof typeof backupChannels | keyof typeof printingChannels

/** Never read or written over IPC: the technician code has its own use cases. */
const SECRET: SettingKey = 'tech.codeHash'

/** A folder chosen by hand, read like a destination's root (`AtlasBackup/full`, `AtlasBackup/live`). */
const pickedFolder = (folder: string): BackupTarget => ({
  id: 'picked',
  role: 'disk',
  targetKey: '',
  describe: () => folder,
  resolveRoot: async () => folder,
  setupRoot: async () => folder
})

const toEntryDto = (entry: BackupEntry, picked: boolean): BackupEntryDto => ({
  source: picked ? 'picked' : entry.source,
  role: entry.role,
  file: entry.file,
  fileName: entry.fileName,
  createdAt: entry.manifest.createdAt,
  kind: entry.manifest.kind,
  schemaVersion: entry.manifest.schemaVersion,
  appVersion: entry.manifest.appVersion
})

/**
 * Who may see and restore backups. With no database open, only the recovery of a corrupt database
 * (nobody can sign in then); otherwise a signed-in user to list, and `backup.restore` or the
 * technician mode to restore.
 */
function requireBackupAccess(ctx: CallContext, deps: IpcDeps, restore: boolean): void {
  if (ctx.noDatabase()) {
    if (deps.runtime.status().report?.state !== 'corrupt') throw new AppErrorException('app_not_ready')
    return
  }
  if (ctx.sessions.isTechnician(ctx.windowId)) return
  const session = ctx.session()
  if (restore) requirePermission(session, 'backup.restore')
}

/** The backups of a picked folder (it must come from `system.pickFolder`), or of the destinations and the data directory. */
async function backupsFor(ctx: CallContext, deps: IpcDeps, folder: string | undefined): Promise<BackupEntryDto[]> {
  if (folder !== undefined) {
    if (!ctx.sessions.hasFolder(ctx.windowId, folder)) throw new AppErrorException('forbidden', { reason: 'folder_not_picked' })
    return (await listBackups([pickedFolder(folder)], folder)).map((entry) => toEntryDto(entry, true))
  }
  const services = deps.runtime.services()
  return (await listBackups(services ? services.targets() : [], deps.paths.backups)).map((entry) => toEntryDto(entry, false))
}

/** Settings, backups, printers and the print queue, the hardware. */
export const systemHandlers: Handlers<SystemChannel> = {
  'settings.getAll': (_input, ctx) => {
    const { [SECRET]: _secret, ...values } = ctx.services().settings.all() as SettingsValues
    return ok(values as Record<string, unknown>)
  },
  'settings.set': ({ key, value }, ctx) => {
    if (!isSettingKey(key) || key === SECRET) throw new AppErrorException('invalid_input', { field: 'key' })
    const services = ctx.services()
    const rule = SETTINGS[key].permission
    const session = ctx.optionalSession()
    if (rule === 'technician') {
      if (!ctx.sessions.isTechnician(ctx.windowId)) throw new AppErrorException('forbidden', { reason: 'technician' })
    } else {
      requirePermission(ctx.session(), rule)
    }
    // The repo validates the value against the registry (`invalid_input`, `params.field`).
    services.uow.run((tx) => services.settings.set(tx, key, value as never, session?.userId))
    return ok(true as const)
  },

  'backup.status': (_input, ctx) => ok(ctx.services().backup.status()),
  'backup.list': async ({ folder }, ctx, deps) => {
    requireBackupAccess(ctx, deps, false)
    return ok(await backupsFor(ctx, deps, folder))
  },
  'backup.run': async (_input, ctx) => {
    const run = await ctx.services().backup.runFull('manual')
    if (!run.ok) return { ok: false, error: run.error }
    const results = run.results.map(({ targetId, role, ok: done, error }) => ({ targetId, role, ok: done, ...(error ? { error } : {}) }))
    return ok({ runId: run.runId, at: run.at, fileName: run.fileName, results })
  },
  'backup.restore': async ({ file, folder }, ctx, deps) => {
    requireBackupAccess(ctx, deps, true)
    const listed = await backupsFor(ctx, deps, folder)
    if (!listed.some((entry) => entry.file === file)) return refuse('backup_not_found')
    const by = ctx.noDatabase() ? null : (ctx.optionalSession()?.userId ?? null)
    deps.log.info('restore.requested', { file, folder: folder ?? null, by })
    // A corrupt database has no readable users, so its restore needs no sign-in (the person is at the
    // till): it is recorded where it survives anything.
    if (ctx.noDatabase()) deps.durableLog?.('restore.unauthenticated', { file, folder: folder ?? null })
    const result = await deps.runtime.restore(file)
    if (!result.ok) return result
    // The users and their rights are the backup's now: everyone signs in again.
    ctx.sessions.clear()
    // In safe mode the restore is the way out: start again normally (the watchdog does).
    if (deps.runtime.status().safeMode) setTimeout(() => deps.shell.restartNormally(), 0)
    else deps.shell.navigateTill(result.value.route)
    return result
  },

  'printing.printers': (_input, ctx) => {
    const { db } = ctx.services()
    const ids = db.prepare('SELECT id FROM printers ORDER BY id').pluck().all() as string[]
    return ok(ids.map((id) => readPrinter(db, id)).filter((printer): printer is PrinterDto => printer !== undefined))
  },
  'printing.jobs': (_input, ctx) => ok(ctx.services().print.queue.list()),
  'printing.reprintJob': ({ jobId }, ctx) => ctx.services().print.queue.reprintJob(jobId),
  'printing.dismissJob': ({ jobId }, ctx) => ctx.services().print.queue.dismissJob(jobId),
  'hardware.detect': async (_input, _ctx, { shell }) => ok(await shell.detectHardware()),
  'hardware.testPrinter': ({ printerId }, ctx) => ctx.services().print.testPrint(printerId),
  'hardware.openDrawer': (_input, ctx) => {
    const { uow, print } = ctx.services()
    const session = ctx.session()
    uow.run((tx) => {
      print.queue.enqueue(tx, { target: { role: 'receipt' }, kind: 'drawer', payload: {} })
      appendEvent(tx.db, { type: 'drawer.opened', entity: 'drawer', userId: session.userId }, tx.clock)
    })
    return ok(true as const)
  }
}
