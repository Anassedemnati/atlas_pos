import type { ModuleKey } from '../modules'
import type { Lang, LocalizedName } from '../names'
import type { Permission } from '../permissions'
import type { WizardDraft } from '../setup/draft'

// The setup wizard, the technician menu and the lists they show.

export type SetupBusinessType = 'restaurant' | 'cafe' | 'bakery' | 'retail'

export interface SetupProfileSummaryDto {
  code: string
  name: LocalizedName
  permissions: Permission[]
  maxDiscountBp: number
}

/** One of the four business templates, for the cards of step 2. */
export interface SetupTemplateDto {
  id: SetupBusinessType
  version: number
  /** The module toggles the template pre-sets. */
  modules: Record<ModuleKey, boolean>
  counts: {
    categories: number
    products: number
    modifierGroups: number
    menus: number
    rooms: number
    tables: number
    paymentMethods: number
    profiles: number
  }
  /** Each category with the printer role that prints it by default (null: nothing is routed). */
  categories: { code: string; name: LocalizedName; color: string; route: 'kitchen' | 'bar' | null }[]
  profiles: SetupProfileSummaryDto[]
}

/** The `.atlasprofile` loaded into the wizard (null when none was). */
export interface LoadedProfileDto {
  createdAt: string
  appVersion: string
  counts: SetupTemplateDto['counts']
  categories: { code: string; name: LocalizedName; color: string }[]
  profiles: SetupProfileSummaryDto[]
}

/** The wizard state as the renderer works with it. */
export interface SetupDraftStateDto {
  draft: WizardDraft
  profile: LoadedProfileDto | null
}

export interface SetupFinishDto {
  installationId: string
  /** `#/login`. The services are open: nothing needs restarting. */
  route: string
  /** What did not go as planned without undoing the setup (`backup_failed`, `backup_target:<id>:<error>`, `autostart_failed`...). */
  warnings: string[]
}

export interface BackupTargetTestDto {
  /** Keep it in the draft's `backups[n].targetKey`. */
  targetKey: string
  writableBytes: number
}

export interface TechChangesDto {
  /** The parts of the setup the call changed: `settings`, `modules`, `printers`, `backups`, `technicianCode`. */
  applied: string[]
}

export interface TechProfileImportDto {
  settings: number
  paymentMethods: number
  catalog: 'none' | 'merged' | 'replaced'
  productsCreated: number
}

export interface LogLineDto {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  data: Record<string, unknown>
}

// Lists ---------------------------------------------------------------------------------------------

export interface RoomDto {
  id: string
  name: LocalizedName
  sort: number
}

export interface TableDto {
  id: string
  roomId: string
  label: string
  shape: 'square' | 'round' | 'rect'
  x: number
  y: number
  w: number
  h: number
  seats: number
  active: boolean
}

export interface FloorDto {
  rooms: RoomDto[]
  tables: TableDto[]
}

export interface PaymentMethodDto {
  id: string
  code: string
  name: LocalizedName
  opensDrawer: boolean
  active: boolean
  sort: number
}

/** The printers that print a category's lines (empty: the first active kitchen printer takes them). */
export interface CategoryRouteDto {
  categoryId: string
  categoryName: LocalizedName
  printerIds: string[]
}

export interface StaffUserDto {
  id: string
  displayName: string
  username: string | null
  profileId: string
  lang: Lang
  active: boolean
  createdAt: string
}

export interface StaffProfileDto {
  id: string
  name: LocalizedName
  permissions: Permission[]
  maxDiscountBp: number
}

export interface StaffDto {
  users: StaffUserDto[]
  profiles: StaffProfileDto[]
}
