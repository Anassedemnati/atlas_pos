import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

// `@shared` is the code shared by main, preload and renderer (no Node, no DOM).
const alias = { '@shared': path('./src/shared') }

// Dependencies in package.json are externalised for main by default (`build.externalizeDeps`),
// so native modules such as better-sqlite3 stay in node_modules.
export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: path('./src/main/index.ts'),
          supervisor: path('./src/main/supervisor.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      // The window is sandboxed: a sandboxed preload must be CommonJS and can only require
      // electron and a few Node built-ins, so every other import has to be bundled in.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: path('./src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: path('./src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: path('./src/renderer/index.html'),
          backoffice: path('./src/renderer/backoffice.html')
        }
      }
    }
  }
})
