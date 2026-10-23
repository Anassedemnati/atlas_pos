import type { Database } from '../../../infrastructure/db/connection'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import { createUsersRepo } from '../../../infrastructure/db/repos/users-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import type { Clock } from '../../ports'
import { createLoginUseCases, type LoginUseCases } from './login'
import { createManageUseCases, type ManageUseCases } from './manage'
import { createOverrideUseCases, type OverrideUseCases } from './override'
import { createTechnicianUseCases, type TechnicianUseCases } from './technician'

export type { SaveUserInput } from './manage'
export type { TillUser } from './login'

export interface UsersDeps {
  db: Database
  uow: UnitOfWork
  clock: Clock
  settings: SettingsRepo
}

export type UsersService = LoginUseCases & ManageUseCases & OverrideUseCases & TechnicianUseCases

/**
 * Users, profiles, till PIN and back office password login, manager override, technician code.
 * One instance per process: it holds the in-memory state (override tokens, blocked clients).
 */
export function createUsersService({ db, uow, clock, settings }: UsersDeps): UsersService {
  const users = createUsersRepo(db)
  return {
    ...createLoginUseCases({ uow, clock, users }),
    ...createManageUseCases({ uow, users }),
    ...createOverrideUseCases({ uow, clock, users }),
    ...createTechnicianUseCases({ uow, settings })
  }
}
