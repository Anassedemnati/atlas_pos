import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AtlasEvent, AtlasEventType } from '@shared/dto'
import { CHANNELS, EVENT_CHANNEL, EVENT_TYPES } from '@shared/ipc/channels'
import type { AtlasBridge } from '@shared/ipc-contract'
import type { Result } from '@shared/result'

// The renderer's only door to the main process: the contract's channels, nothing else (no ipcRenderer,
// no Node). Inputs are validated again in the main process. The script is sandboxed, so it is CommonJS
// with its imports bundled in; it imports plain lists only, not the schemas.

const channels = new Set<string>(CHANNELS)
const eventTypes = new Set<string>(EVENT_TYPES)

const refusal = (code: string): Result<never> => ({ ok: false, error: { code, messageKey: `errors.${code}` } })

const bridge: AtlasBridge = {
  invoke(channel, input) {
    if (!channels.has(channel)) return Promise.resolve(refusal('unknown_channel'))
    return ipcRenderer.invoke(channel, input)
  },
  on<T extends AtlasEventType>(type: T, callback: (event: Extract<AtlasEvent, { type: T }>) => void) {
    if (!eventTypes.has(type)) return () => {}
    const listener = (_event: IpcRendererEvent, payload: AtlasEvent): void => {
      if (payload?.type === type) callback(payload as Extract<AtlasEvent, { type: T }>)
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('atlas', bridge)
