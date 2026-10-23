import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) }
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The crash harness (50 kills) runs alone after the rest (see `npm test`); under load a sub-second test
    // can still take several seconds, so the default 5 s is too tight.
    testTimeout: 15000
  }
})
