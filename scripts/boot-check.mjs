// Launches the built app (out/) non-interactively and checks that it boots.
// Run `npm run build` first. Exit code 0 only if the app prints ATLAS_BOOT_OK.
// Usage: node scripts/boot-check.mjs [timeoutMs]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const timeoutMs = Number(process.argv[2] ?? 30_000)

const env = { ...process.env, ATLAS_EXIT_AFTER_BOOT: '1' }
delete env.ELECTRON_RUN_AS_NODE

// --no-sandbox is only needed on Linux CI/containers running as root; harmless elsewhere.
const args = process.platform === 'linux' ? ['--no-sandbox', '.'] : ['.']
const child = spawn(electronBin, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })

let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})

const timer = setTimeout(() => {
  console.error(`boot-check: timed out after ${timeoutMs} ms`)
  child.kill('SIGKILL')
}, timeoutMs)

child.on('exit', (code) => {
  clearTimeout(timer)
  const ok = code === 0 && output.includes('ATLAS_BOOT_OK')
  if (!ok) console.error(`boot-check: failed (exit code ${code})`)
  process.exit(ok ? 0 : 1)
})
