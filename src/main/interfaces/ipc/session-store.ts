import { resolve } from 'node:path'
import type { SessionDto } from '@shared/dto'
import type { Session } from '../../domain/users/session'
import type { UsersRepo } from '../../infrastructure/db/repos/users-repo'

/** What the main process remembers about one window (one `webContents.id`). */
interface Entry {
  /** The signed-in user; the session is rebuilt from the database on each call. */
  userId: string | null
  /** The technician code was entered in this window. */
  technician: boolean
  /** Folders the user chose in a system dialog: the only folders a channel may be given by path. */
  folders: Set<string>
}

/**
 * Sessions are kept here, per window, never in the renderer: it sends a PIN and gets a summary back.
 * A window only ever sees its own entry.
 */
export interface SessionStore {
  signIn(windowId: number, userId: string): void
  /** Signs the user out of the window; the technician mode ends with it. */
  signOut(windowId: number): void
  setTechnician(windowId: number): void
  isTechnician(windowId: number): boolean
  /**
   * The window's session, read again from the database: a user deactivated since, or whose profile is
   * gone, is signed out (null). The permissions are the profile's as it is now.
   */
  session(windowId: number, users: Pick<UsersRepo, 'getUser' | 'getProfile'>): Session | null
  grantFolder(windowId: number, folder: string): void
  hasFolder(windowId: number, folder: string): boolean
  /** The window is gone (closed, crashed, navigated to another document). */
  forget(windowId: number): void
  /** Everyone is signed out (after a restore the users may not be the same). */
  clear(): void
}

export function createSessionStore(): SessionStore {
  const entries = new Map<number, Entry>()
  const entry = (windowId: number): Entry => {
    let found = entries.get(windowId)
    if (!found) {
      found = { userId: null, technician: false, folders: new Set() }
      entries.set(windowId, found)
    }
    return found
  }

  return {
    signIn(windowId, userId) {
      entry(windowId).userId = userId
    },
    signOut(windowId) {
      const found = entries.get(windowId)
      if (!found) return
      found.userId = null
      found.technician = false
    },
    setTechnician(windowId) {
      entry(windowId).technician = true
    },
    isTechnician: (windowId) => entries.get(windowId)?.technician === true,
    session(windowId, users) {
      const found = entries.get(windowId)
      if (!found?.userId) return null
      const user = users.getUser(found.userId)
      const profile = user?.active ? users.getProfile(user.profileId) : undefined
      if (!user || !profile) {
        found.userId = null
        found.technician = false
        return null
      }
      return {
        userId: user.id,
        displayName: user.displayName,
        lang: user.lang,
        permissions: new Set(profile.permissions),
        maxDiscountBp: profile.maxDiscountBp,
        isTechnician: found.technician
      }
    },
    grantFolder(windowId, folder) {
      entry(windowId).folders.add(resolve(folder))
    },
    hasFolder: (windowId, folder) => entries.get(windowId)?.folders.has(resolve(folder)) === true,
    forget(windowId) {
      entries.delete(windowId)
    },
    clear() {
      entries.clear()
    }
  }
}

export const toSessionDto = (session: Session): SessionDto => ({
  userId: session.userId,
  displayName: session.displayName,
  lang: session.lang,
  permissions: [...session.permissions],
  maxDiscountBp: session.maxDiscountBp,
  isTechnician: session.isTechnician
})
