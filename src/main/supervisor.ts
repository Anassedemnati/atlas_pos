// The watchdog. Run as `process.execPath` with ELECTRON_RUN_AS_NODE=1 (plain Node, no window): it starts
// the application with `--child`, restarts it 1 s after a crash, and after 3 crashes within 5 minutes
// starts it with `--safe-mode` (see `onChildExit`). A clean exit (code 0: quit to desktop, the OS logging
// out) ends it too; exit code 75 asks for a normal start again. Production only; `main/index.ts`
// relaunches itself under it.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './paths'
import { initialState, onChildExit } from './supervisor-policy'

const logsDir = join(resolveDataDir(process.env, process.platform), 'logs')
const forwarded = process.argv.slice(2).filter((arg) => arg !== '--child' && arg !== '--safe-mode')
/** `supervisor.log` is rotated to `supervisor.log.1` past this size. */
const MAX_LOG_BYTES = 1024 * 1024
let state = initialState()
let stopping = false
let child: ReturnType<typeof spawn> | null = null

function log(message: string): void {
  try {
    mkdirSync(logsDir, { recursive: true })
    const file = join(logsDir, 'supervisor.log')
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // No log yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Nowhere to write: keep supervising anyway.
  }
}

/** The application binary: an AppImage is started through its own file (its mount goes away with the first run). */
const executable = (): string => process.env['APPIMAGE'] || process.execPath

function launch(safeMode: boolean): void {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const args = [...forwarded, '--child', ...(safeMode ? ['--safe-mode'] : [])]
  log(`start ${safeMode ? 'safe-mode' : 'normal'}`)
  const started = spawn(executable(), args, { env, stdio: 'ignore' })
  child = started
  // 'error' (it could not start) and 'exit' may both come: one end per run.
  let ended = false
  const end = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (ended) return
    ended = true
    onExit(code, signal)
  }
  started.on('error', (error) => {
    log(`spawn failed: ${error.message}`)
    end(null, null)
  })
  started.on('exit', end)
}

function onExit(code: number | null, signal: NodeJS.Signals | null): void {
  child = null
  const next = onChildExit(state, stopping ? 0 : code, Date.now())
  state = next.state
  const { decision } = next
  if (decision.kind === 'stop') {
    log(`exit code=${code} signal=${signal}: stopping`)
    process.exit(0)
  }
  log(`exit code=${code} signal=${signal}: ${decision.safeMode ? 'safe-mode' : 'restart'} in ${decision.delayMs} ms`)
  setTimeout(() => launch(decision.safeMode), decision.delayMs)
}

// The OS shutting down (or a service manager) stops the supervisor: stop the application with it,
// without counting it as a crash.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopping = true
    log(`${signal}: stopping the application`)
    if (child) child.kill(signal)
    else process.exit(0)
  })
}

launch(false)
