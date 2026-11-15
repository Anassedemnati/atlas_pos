import type { appChannels } from '@shared/ipc/app'
import { refuse } from '../../application/usecases/users/outcome'
import { ok, requireTechnicianOrNoDatabase, requireUserOrNoDatabase, type Handlers } from './context'

/** The shell: start-up report, leaving the kiosk, dialogs, customer display. */
export const appHandlers: Handlers<keyof typeof appChannels> = {
  'app.startupReport': (_input, _ctx, { runtime, shell }) => {
    const status = runtime.status()
    return ok({
      report: status.report,
      startupError: status.startupError,
      route: status.route,
      safeMode: status.safeMode,
      ready: status.ready,
      version: shell.appVersion
    })
  },
  'app.quitToDesktop': (_input, ctx, { shell, log }) => {
    requireTechnicianOrNoDatabase(ctx)
    log.info('app.quit_to_desktop')
    // After the answer has gone back to the window.
    setTimeout(() => shell.quitToDesktop(), 0)
    return ok(true as const)
  },
  'app.restartNormally': (_input, ctx, { runtime, shell, log }) => {
    requireUserOrNoDatabase(ctx)
    if (!runtime.status().safeMode) return refuse('not_in_safe_mode')
    log.info('app.restart_normally')
    setTimeout(() => shell.restartNormally(), 0)
    return ok(true as const)
  },
  'system.pickFolder': async ({ title }, ctx, { shell }) => {
    requireUserOrNoDatabase(ctx)
    const folder = await shell.pickFolder(ctx.windowId, title)
    if (folder !== null) ctx.sessions.grantFolder(ctx.windowId, folder)
    return ok(folder)
  },
  'system.pickFile': async ({ title, extensions }, ctx, { shell }) => {
    requireUserOrNoDatabase(ctx)
    return ok(await shell.pickFile(ctx.windowId, { ...(title ? { title } : {}), ...(extensions ? { extensions } : {}) }))
  },
  'display.update': ({ orderId }, ctx, { shell }) => {
    if (orderId === null) {
      shell.showOnDisplay(null)
      return ok(true as const)
    }
    const order = ctx.services().orders.getOrder(ctx.session(), orderId)
    if (!order.ok) return order
    shell.showOnDisplay(order.value)
    return ok(true as const)
  }
}
