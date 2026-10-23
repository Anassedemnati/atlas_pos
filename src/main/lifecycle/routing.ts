import type { StartupState } from '../application/usecases/startup/startup-check'

/** Where the till window opens, from the start-up check (null when the check itself failed). */
export function routeFor(state: StartupState | null, options: { safeMode: boolean }): string {
  switch (state) {
    case 'needs-setup':
      return '#/setup'
    case 'corrupt':
      return '#/recovery?mode=corrupt'
    case 'newer-schema':
      // "Mise à jour requise": restoring an older backup is not the fix, so no restore is offered.
      return '#/recovery?mode=newer-schema'
    case null:
      return '#/recovery?mode=error'
    case 'recovered':
    case 'ok':
      // Started by the watchdog after repeated crashes: restore a backup or send the logs.
      if (options.safeMode) return '#/recovery?mode=safe'
      return state === 'recovered' ? '#/recovery' : '#/login'
  }
}

/** The database is opened (and the use cases built) for these states only. */
export const opensDatabase = (state: StartupState): boolean => state === 'ok' || state === 'recovered'
