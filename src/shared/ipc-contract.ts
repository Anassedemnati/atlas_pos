import type { z } from 'zod'
import type { AtlasEvent, AtlasEventType } from './dto'
import type { Result } from './result'
import { appChannels } from './ipc/app'
import { catalogChannels } from './ipc/catalog'
import { configChannels } from './ipc/config'
import type { ChannelDef } from './ipc/define'
import { invoicesChannels } from './ipc/invoices'
import { ordersChannels } from './ipc/orders'
import { customersChannels, daysChannels, ticketsChannels } from './ipc/sales'
import { setupChannels, techChannels } from './ipc/setup'
import { backupChannels, printingChannels, settingsChannels } from './ipc/system'
import { tillChannels } from './ipc/till'
import { usersChannels } from './ipc/users'

/**
 * Every call the renderer can make to the main process, as `area.verb`, with its input schema (checked
 * in the main process), who may call it, and its result type. An area lives in its own file under
 * `ipc/`; adding one is a spread here (and its handlers in `main/interfaces/ipc/`).
 */
export const IpcContract = {
  ...appChannels,
  ...usersChannels,
  ...catalogChannels,
  ...ordersChannels,
  ...ticketsChannels,
  ...daysChannels,
  ...customersChannels,
  ...invoicesChannels,
  ...settingsChannels,
  ...backupChannels,
  ...printingChannels,
  ...configChannels,
  ...setupChannels,
  ...techChannels,
  ...tillChannels
} satisfies Record<string, ChannelDef>

export type IpcContract = typeof IpcContract
export type Channel = keyof IpcContract
/** What the renderer sends. */
export type In<C extends Channel> = z.input<IpcContract[C]['input']>
/** What the handler receives, once validated. */
export type Parsed<C extends Channel> = z.output<IpcContract[C]['input']>
/** What a successful call returns. */
export type Out<C extends Channel> = Exclude<IpcContract[C]['output'], undefined>

export { EVENT_CHANNEL } from './ipc/channels'

/** `window.atlas`, exposed by the preload. */
export interface AtlasBridge {
  invoke<C extends Channel>(channel: C, input: In<C>): Promise<Result<Out<C>>>
  /** Returns the function that stops listening. */
  on<T extends AtlasEventType>(type: T, callback: (event: Extract<AtlasEvent, { type: T }>) => void): () => void
}
