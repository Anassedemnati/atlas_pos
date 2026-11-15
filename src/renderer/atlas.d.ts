import type { AtlasBridge } from '@shared/ipc-contract'

declare global {
  interface Window {
    /** The preload bridge to the main process (see `src/shared/ipc-contract.ts`). */
    atlas: AtlasBridge
  }
}
