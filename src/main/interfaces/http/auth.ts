import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ParsedCatalogSheet } from '@shared/dto'
import type { Clock } from '../../application/ports'

/** The cookie that carries the session id. */
export const SESSION_COOKIE = 'atlas_sid'
/** The header every request that changes something must carry (the value `login` and `me` returned). */
export const CSRF_HEADER = 'x-csrf-token'
/** A session lives 8 hours from the login. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000
/** The most sessions held at once: a LAN has a handful of managers, not thousands. */
const MAX_SESSIONS = 50
const MAX_PREVIEWS = 5

/** A sheet read by the import preview. The apply step takes this, never rows from the browser. */
export interface ImportPreview {
  parsed: ParsedCatalogSheet
  fileName: string
}

export interface HttpSession {
  id: string
  /** The key of this session in the IPC `SessionStore` (which holds the user and rebuilds the permissions on each call). */
  windowId: number
  userId: string
  csrfToken: string
  expiresAt: number
  previews: Map<string, ImportPreview>
}

export interface HttpSessions {
  create(userId: string): HttpSession
  /** The live session of this cookie value, or undefined (unknown or expired: an expired one is dropped). */
  get(id: string | undefined): HttpSession | undefined
  destroy(id: string): void
  /** Everyone is signed out (after a restore the users may not be the same). */
  clear(): void
  /** Calls `visit` with the window id of every session dropped, so that the user bindings can go too. */
  onDrop(visit: (windowId: number) => void): void
  addPreview(session: HttpSession, id: string, preview: ImportPreview): void
}

const token = (bytes: number): string => randomBytes(bytes).toString('base64url')

export function createHttpSessions(clock: Clock): HttpSessions {
  const sessions = new Map<string, HttpSession>()
  const drops: ((windowId: number) => void)[] = []
  let nextWindow = 1

  const drop = (session: HttpSession): void => {
    sessions.delete(session.id)
    for (const visit of drops) visit(session.windowId)
  }

  return {
    create(userId) {
      const now = clock.now().getTime()
      for (const session of [...sessions.values()]) if (session.expiresAt <= now) drop(session)
      // The oldest goes first when the table is full.
      while (sessions.size >= MAX_SESSIONS) drop(sessions.values().next().value as HttpSession)
      const session: HttpSession = {
        id: token(32),
        windowId: nextWindow++,
        userId,
        csrfToken: token(32),
        expiresAt: now + SESSION_TTL_MS,
        previews: new Map()
      }
      sessions.set(session.id, session)
      return session
    },
    get(id) {
      if (!id) return undefined
      const found = sessions.get(id)
      if (!found) return undefined
      if (found.expiresAt <= clock.now().getTime()) {
        drop(found)
        return undefined
      }
      return found
    },
    destroy(id) {
      const found = sessions.get(id)
      if (found) drop(found)
    },
    clear() {
      for (const session of [...sessions.values()]) drop(session)
    },
    onDrop: (visit) => void drops.push(visit),
    addPreview(session, id, preview) {
      session.previews.set(id, preview)
      while (session.previews.size > MAX_PREVIEWS) session.previews.delete(session.previews.keys().next().value as string)
    }
  }
}

/** Constant-time equality of two tokens (a different length is a mismatch, without comparing). */
export function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const newPreviewId = (): string => token(12)
