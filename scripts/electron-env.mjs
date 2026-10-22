// Runs `electron-vite <args>` with ELECTRON_RUN_AS_NODE removed.
//
// VS Code (and some other shells) export ELECTRON_RUN_AS_NODE=1. With it set, the
// electron binary behaves as plain Node and `import { app } from 'electron'` fails.
// Usage: node scripts/electron-env.mjs dev|preview [electron-vite args]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// The package `exports` map hides `bin/`, so locate it from package.json.
const require = createRequire(import.meta.url)
const electronViteBin = join(
  dirname(require.resolve('electron-vite/package.json')),
  'bin',
  'electron-vite.js'
)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [electronViteBin, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
