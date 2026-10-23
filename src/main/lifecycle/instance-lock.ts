import type { App } from 'electron'

/**
 * One running copy: a second launch (a double-click on the icon, the autostart racing a manual start)
 * hands over to the first, which shows its till window, and quits. Returns false in that second copy.
 */
export function acquireInstanceLock(app: Pick<App, 'requestSingleInstanceLock' | 'on'>, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', onSecondInstance)
  return true
}
