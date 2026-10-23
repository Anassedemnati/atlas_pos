import type { Lang, LocalizedName } from '@shared/names'
import type { Permission } from '@shared/permissions'
import { isManagerPermissions, parsePermissions } from '../../../domain/users/profile'
import type { Database } from '../connection'
import type { Tx } from '../uow'

export interface UserRecord {
  id: string
  displayName: string
  pinHash: string
  /** Lower-case; null for a user who only uses the till. */
  username: string | null
  passwordHash: string | null
  profileId: string
  lang: Lang
  active: boolean
  failedLogins: number
  /** ISO instant while a lock may be running; null when there is none. */
  lockedUntil: string | null
  createdAt: string
}

export interface ProfileRecord {
  id: string
  name: LocalizedName
  permissions: Permission[]
  maxDiscountBp: number
}

interface UserRow {
  id: string
  display_name: string
  pin_hash: string
  username: string | null
  password_hash: string | null
  profile_id: string
  lang: string
  active: number
  failed_logins: number
  locked_until: string | null
  created_at: string
}

interface ProfileRow {
  id: string
  name_json: string
  permissions_json: string
  max_discount_bp: number
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  displayName: row.display_name,
  pinHash: row.pin_hash,
  username: row.username,
  passwordHash: row.password_hash,
  profileId: row.profile_id,
  lang: row.lang === 'ar' || row.lang === 'en' ? row.lang : 'fr',
  active: row.active === 1,
  failedLogins: row.failed_logins,
  lockedUntil: row.locked_until,
  createdAt: row.created_at
})

const toProfile = (row: ProfileRow): ProfileRecord => {
  let name: LocalizedName
  try {
    name = JSON.parse(row.name_json) as LocalizedName
  } catch {
    name = { fr: row.id }
  }
  return {
    id: row.id,
    name,
    permissions: parsePermissions(row.permissions_json),
    maxDiscountBp: row.max_discount_bp
  }
}

/** The columns an edit owns. The failure counters belong to the login paths and are never written from here. */
export type UserEdit = Omit<UserRecord, 'failedLogins' | 'lockedUntil' | 'createdAt'>

export interface UsersRepo {
  getUser(id: string): UserRecord | undefined
  /** `username` in its stored form (lower-case). */
  findByUsername(username: string): UserRecord | undefined
  /** Everyone, in creation order (the order of the PIN tiles). */
  listUsers(): UserRecord[]
  getProfile(id: string): ProfileRecord | undefined
  /** Active users whose profile holds every permission. */
  countActiveManagers(): number

  insertUser(tx: Tx, user: UserEdit): void
  updateUser(tx: Tx, user: UserEdit): void
  insertProfile(tx: Tx, profile: ProfileRecord): void
  updateProfile(tx: Tx, profile: ProfileRecord): void

  /** Counts one more failure in SQL (never a value read earlier) and returns the new count. */
  recordFailure(tx: Tx, userId: string): number
  /** Starts a lock and restarts the count, so that the next 5 tries are fresh once it ends. */
  lock(tx: Tx, userId: string, until: string): void
  clearFailures(tx: Tx, userId: string): void
}

export function createUsersRepo(db: Database): UsersRepo {
  const userRow = (sql: string, ...args: unknown[]): UserRecord | undefined => {
    const row = db.prepare(sql).get(...args) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  return {
    getUser: (id) => userRow('SELECT * FROM users WHERE id = ?', id),

    findByUsername: (username) => userRow('SELECT * FROM users WHERE username = ?', username),

    listUsers: () =>
      (db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as UserRow[]).map(toUser),

    getProfile(id) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined
      return row ? toProfile(row) : undefined
    },

    countActiveManagers() {
      const rows = db
        .prepare(
          `SELECT p.permissions_json FROM users u JOIN profiles p ON p.id = u.profile_id WHERE u.active = 1`
        )
        .all() as { permissions_json: string }[]
      return rows.filter((row) => isManagerPermissions(parsePermissions(row.permissions_json))).length
    },

    insertUser(tx, u) {
      tx.db
        .prepare(
          `INSERT INTO users (id, display_name, pin_hash, username, password_hash, profile_id, lang, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          u.id,
          u.displayName,
          u.pinHash,
          u.username,
          u.passwordHash,
          u.profileId,
          u.lang,
          u.active ? 1 : 0,
          tx.clock.now().toISOString()
        )
    },

    updateUser(tx, u) {
      tx.db
        .prepare(
          `UPDATE users SET display_name = ?, pin_hash = ?, username = ?, password_hash = ?,
                            profile_id = ?, lang = ?, active = ?
           WHERE id = ?`
        )
        .run(u.displayName, u.pinHash, u.username, u.passwordHash, u.profileId, u.lang, u.active ? 1 : 0, u.id)
    },

    insertProfile(tx, p) {
      tx.db
        .prepare('INSERT INTO profiles (id, name_json, permissions_json, max_discount_bp) VALUES (?, ?, ?, ?)')
        .run(p.id, JSON.stringify(p.name), JSON.stringify(p.permissions), p.maxDiscountBp)
    },

    updateProfile(tx, p) {
      tx.db
        .prepare('UPDATE profiles SET name_json = ?, permissions_json = ?, max_discount_bp = ? WHERE id = ?')
        .run(JSON.stringify(p.name), JSON.stringify(p.permissions), p.maxDiscountBp, p.id)
    },

    recordFailure(tx, userId) {
      tx.db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?').run(userId)
      const row = tx.db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(userId) as
        | { failed_logins: number }
        | undefined
      return row?.failed_logins ?? 0
    },

    lock(tx, userId, until) {
      tx.db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(until, userId)
    },

    clearFailures(tx, userId) {
      tx.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(userId)
    }
  }
}
