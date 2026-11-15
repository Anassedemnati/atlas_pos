import { hashSecret } from '../../src/main/infrastructure/security/password'
import { PERMISSIONS, type Permission } from '../../src/shared/permissions'
import { createEventBus } from '../../src/main/application/events'
import { createSettingsRepo, type SettingsRepo } from '../../src/main/infrastructure/db/repos/settings-repo'
import { createUnitOfWork, type UnitOfWork } from '../../src/main/infrastructure/db/uow'
import { createUsersService, type UsersService } from '../../src/main/application/usecases/users'
import type { Session } from '../../src/main/domain/users/session'
import type { Database } from '../../src/main/infrastructure/db/connection'
import { mutableClock, type MutableClock } from './clock'
import { tempDb, type TempDb } from './db'

/** One scrypt costs ~100 ms: a secret is hashed once per test run, and any valid hash verifies. */
const hashes = new Map<string, string>()
const hashOnce = (secret: string): string => {
  let hash = hashes.get(secret)
  if (!hash) {
    hash = hashSecret(secret)
    hashes.set(secret, hash)
  }
  return hash
}

export const PINS = { amine: '1234', sara: '2345', youssef: '3456' } as const
export const AMINE_USERNAME = 'amine'
export const AMINE_PASSWORD = 'Atlas-Secret-2026'
export const TECHNICIAN_CODE = '987654'

export const CASHIER_PERMISSIONS: Permission[] = ['order.discount', 'report.x', 'ticket.reprint']

export interface Seeded {
  profiles: { gerant: string; caissier: string; serveur: string }
  users: { amine: string; sara: string; youssef: string }
}

/** Gérant (all permissions, 100 %), Caissier (max 10 %) and Serveur (0 %), and one user on each. */
export function seedUsers(db: Database, createdAt = '2026-10-01T08:00:00.000Z'): Seeded {
  const profiles = { gerant: 'p-gerant', caissier: 'p-caissier', serveur: 'p-serveur' }
  const users = { amine: 'u-amine', sara: 'u-sara', youssef: 'u-youssef' }
  const addProfile = (id: string, fr: string, permissions: readonly Permission[], maxDiscountBp: number): void => {
    db.prepare('INSERT INTO profiles (id, name_json, permissions_json, max_discount_bp) VALUES (?, ?, ?, ?)').run(
      id,
      JSON.stringify({ fr }),
      JSON.stringify(permissions),
      maxDiscountBp
    )
  }
  addProfile(profiles.gerant, 'Gérant', PERMISSIONS, 10000)
  addProfile(profiles.caissier, 'Caissier', CASHIER_PERMISSIONS, 1000)
  addProfile(profiles.serveur, 'Serveur', ['order.discount'], 0)
  const addUser = (
    id: string,
    displayName: string,
    pin: string,
    profileId: string,
    credentials?: { username: string; password: string }
  ): void => {
    db.prepare(
      `INSERT INTO users (id, display_name, pin_hash, username, password_hash, profile_id, lang, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'fr', 1, ?)`
    ).run(
      id,
      displayName,
      hashOnce(pin),
      credentials?.username ?? null,
      credentials ? hashOnce(credentials.password) : null,
      profileId,
      createdAt
    )
  }
  addUser(users.amine, 'Amine Benali', PINS.amine, profiles.gerant, { username: AMINE_USERNAME, password: AMINE_PASSWORD })
  addUser(users.sara, 'Sara El Idrissi', PINS.sara, profiles.caissier)
  addUser(users.youssef, 'Youssef', PINS.youssef, profiles.serveur)
  return { profiles, users }
}

/** A session without logging in (a login costs a scrypt). */
export function sessionOf(
  userId: string,
  permissions: readonly Permission[],
  maxDiscountBp = 0
): Session {
  return { userId, displayName: userId, lang: 'fr', permissions: new Set(permissions), maxDiscountBp, isTechnician: false }
}

export interface UsersHarness {
  t: TempDb
  clock: MutableClock
  uow: UnitOfWork
  settings: SettingsRepo
  service: UsersService
  seeded: Seeded
  /** A second service on the same database, as after an application restart. */
  restart(): UsersService
  manager: Session
  cashier: Session
  eventRows(): { type: string; entity: string; entity_id: string | null; user_id: string | null; data_json: string | null }[]
  cleanup(): void
}

export function usersHarness(): UsersHarness {
  const t = tempDb()
  const clock = mutableClock()
  const uow = createUnitOfWork(t.db, clock, createEventBus())
  const settings = createSettingsRepo(t.db)
  const make = (): UsersService => createUsersService({ db: t.db, uow, clock, settings })
  const seeded = seedUsers(t.db)
  return {
    t,
    clock,
    uow,
    settings,
    service: make(),
    seeded,
    restart: make,
    manager: sessionOf(seeded.users.amine, PERMISSIONS, 10000),
    cashier: sessionOf(seeded.users.sara, CASHIER_PERMISSIONS, 1000),
    eventRows: () =>
      t.db.prepare('SELECT type, entity, entity_id, user_id, data_json FROM event_log ORDER BY id').all() as ReturnType<
        UsersHarness['eventRows']
      >,
    cleanup: () => t.cleanup()
  }
}
