import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomic } from '../infrastructure/fs/atomic'

const DESKTOP_FILE = 'atlas-pos.desktop'

/** The executable the OS should start: the AppImage itself when running from one. */
const executable = (): string => process.env['APPIMAGE'] || process.execPath

/** The XDG autostart entry (`~/.config/autostart/atlas-pos.desktop`). */
export function desktopEntry(exec: string): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Atlas POS', `Exec="${exec}"`, 'X-GNOME-Autostart-enabled=true', ''].join('\n')
}

/**
 * Starts the application at the OS login (or stops doing so): Windows and macOS through the login
 * items, Linux through an XDG autostart entry. Production only: in development it would register the
 * bare Electron binary.
 */
export function setAutostart(enabled: boolean): void {
  if (!app.isPackaged) return
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
    return
  }
  const dir = join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'autostart')
  const file = join(dir, DESKTOP_FILE)
  if (!enabled) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(dir, { recursive: true })
  writeFileAtomic(file, desktopEntry(executable()))
}
