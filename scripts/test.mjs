// `npm test`: the whole suite, then the crash harness alone (50 kills; it is timing sensitive, so it must not
// share the machine with the other files). Runs vitest's own entry with this node, with no shell: the same on
// Windows (cmd.exe does not strip single quotes) and everywhere else. Stops at the first failing run.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

const run = (args) => spawnSync(process.execPath, [vitest, 'run', ...args], { stdio: 'inherit' })

for (const args of [['--exclude', 'tests/integration/crash/**'], ['tests/integration/crash']]) {
  const { status, error } = run(args)
  if (error) {
    console.error(error)
    process.exit(1)
  }
  // `status` is null when vitest was killed by a signal.
  if (status !== 0) process.exit(status ?? 1)
}
