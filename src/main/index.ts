import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { runBootCheck } from './boot-check'

const here = dirname(fileURLToPath(import.meta.url))
const exitAfterBoot = process.env['ATLAS_EXIT_AFTER_BOOT'] === '1'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Atlas POS',
    backgroundColor: '#F4F5F7',
    show: !exitAfterBoot,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(here, '../renderer/index.html'))
  }

  if (exitAfterBoot) runBootCheck(window)
  return window
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => app.quit())
