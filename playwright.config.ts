import { defineConfig } from '@playwright/test'

// The dev shell (VS Code) sets ELECTRON_RUN_AS_NODE=1, which makes Electron behave as plain Node.
// Playwright workers inherit this environment, so clear it before any Electron launch.
delete process.env['ELECTRON_RUN_AS_NODE']

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { trace: 'retain-on-failure' }
})
