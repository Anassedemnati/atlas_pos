// Launches the built app (out/) non-interactively and checks that it boots, twice, each time on a new
// temporary data directory:
// - fresh (nothing in it): the till window must open on #/setup;
// - seeded (a completed installation.json and a migrated database): it must open on #/login;
// - unwritable (its `config/` read-only, so the running lock cannot be taken; not on Windows or as root):
//   the start must fail fast with a non-zero exit and `logs/fatal.log`, not hang without a window.
// Run `npm run build` first. Exit code 0 only if every run behaves as expected.
// Usage: node scripts/boot-check.mjs [timeoutMs]
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const timeoutMs = Number(process.argv[2] ?? 30_000)
const migrationsDir = fileURLToPath(new URL('../src/main/infrastructure/db/migrations/', import.meta.url))

/** What `finishSetup` leaves behind, enough for the start-up check: the installation file and a migrated database. */
function seed(dataDir) {
  const Database = require('better-sqlite3')
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  mkdirSync(join(dataDir, 'db'), { recursive: true })
  const now = new Date().toISOString()
  const installation = { installationId: 'boot-check', createdAt: now, setupCompletedAt: now, appVersion: '0.0.0' }
  writeFileSync(join(dataDir, 'config', 'installation.json'), `${JSON.stringify(installation, null, 2)}\n`)
  const db = new Database(join(dataDir, 'db', 'atlas.db'))
  try {
    db.pragma('journal_mode = WAL')
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    files.forEach((name, index) => {
      db.exec(readFileSync(join(migrationsDir, name), 'utf8'))
      db.pragma(`user_version = ${index + 1}`)
    })
  } finally {
    db.close()
  }
}

/** A data directory whose `config/` cannot be written: taking the running lock fails (EACCES). */
function unwritable(dataDir) {
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  chmodSync(join(dataDir, 'config'), 0o500)
}

/** `expected` is the route the till must open on, or null for a start that must fail. */
function boot(dataDir, expected) {
  return new Promise((resolve) => {
    const env = { ...process.env, ATLAS_EXIT_AFTER_BOOT: '1', ATLAS_DATA_DIR: dataDir }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
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
    const finish = (ok, why) => {
      clearTimeout(timer)
      if (!ok) console.error(`boot-check: ${why}`)
      resolve(ok)
    }
    child.on('error', (error) => finish(false, `could not start electron: ${error.message}`))
    child.on('exit', (code, signal) => {
      if (expected === null) {
        const fatal = join(dataDir, 'logs', 'fatal.log')
        const logged = existsSync(fatal) && readFileSync(fatal, 'utf8').includes('app.start_failed')
        if (signal !== null || code === 0) return finish(false, `expected a failed start, got exit code ${code} signal ${signal}`)
        if (!logged) return finish(false, 'no app.start_failed line in logs/fatal.log')
        console.log(`boot-check: failed start as expected (exit code ${code}, logs/fatal.log written)`)
        return finish(true)
      }
      const route = /ATLAS_BOOT_ROUTE (\S+)/.exec(output)?.[1]
      if (code !== 0 || !output.includes('ATLAS_BOOT_OK')) return finish(false, `failed (exit code ${code})`)
      if (route !== expected) return finish(false, `route ${route}, expected ${expected}`)
      finish(true)
    })
  })
}

let failed = false
const canMakeUnwritable = process.platform !== 'win32' && process.getuid?.() !== 0
const scenarios = [
  { name: 'fresh', expected: '#/setup', prepare: () => {} },
  { name: 'seeded', expected: '#/login', prepare: seed },
  ...(canMakeUnwritable ? [{ name: 'unwritable', expected: null, prepare: unwritable }] : [])
]
for (const { name, expected, prepare } of scenarios) {
  const dataDir = mkdtempSync(join(tmpdir(), `atlas-boot-${name}-`))
  try {
    prepare(dataDir)
    console.log(`boot-check: ${name} data directory, expecting ${expected ?? 'a failed start'}`)
    if (!(await boot(dataDir, expected))) failed = true
  } finally {
    if (existsSync(join(dataDir, 'config'))) chmodSync(join(dataDir, 'config'), 0o700)
    rmSync(dataDir, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
