// Data transfer objects: what crosses the IPC / HTTP boundary to the renderer and the back office.
// Plain data only (no classes, no Dates); `null` is "absent", as in the database.

export type * from './catalog'
export type * from './orders'
export type * from './tickets'
export type * from './users'
export type * from './system'
export type * from './setup'
export type * from './events'
