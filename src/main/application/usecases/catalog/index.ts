import type { CatalogDto } from '@shared/dto'
import type { Database } from '../../../infrastructure/db/connection'
import { createCatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { createCategoryUseCases, type CategoryUseCases } from './categories'
import { createImportExportUseCases, type ImportExportUseCases } from './import-export'
import { createMenuUseCases, type MenuUseCases } from './menus'
import { createModifierUseCases, type ModifierUseCases } from './modifiers'
import { createProductUseCases, type ProductUseCases } from './products'
import { createReorderUseCases, type ReorderUseCases } from './reorder'

export type { CategoryInput, MenuInput, ModifierGroupInput, ProductInput, ReorderKind } from '../../../domain/catalog/inputs'

export interface CatalogDeps {
  db: Database
  uow: UnitOfWork
  /** Read for `vat.rates` at every call that checks a VAT rate. */
  settings: SettingsRepo
}

export interface ReadCatalog {
  /**
   * The whole catalogue in display order, inactive categories and products included (`active` says
   * which). Every signed-in user may read it: the till needs it to sell.
   */
  listCatalog(): CatalogDto
}

export type CatalogService = ReadCatalog &
  CategoryUseCases &
  ProductUseCases &
  ModifierUseCases &
  MenuUseCases &
  ReorderUseCases &
  ImportExportUseCases

/**
 * Categories, products, modifier groups, set menus, stock, and the Excel/CSV import and export.
 * Every change needs `catalog.manage`, runs in one transaction, is written to the event log and
 * announces `catalog.changed` once it is committed.
 */
export function createCatalogService({ db, uow, settings }: CatalogDeps): CatalogService {
  const repo = createCatalogRepo(db)
  return {
    listCatalog: () => repo.list(),
    ...createCategoryUseCases({ repo, uow }),
    ...createProductUseCases({ repo, uow, settings }),
    ...createModifierUseCases({ repo, uow }),
    ...createMenuUseCases({ repo, uow }),
    ...createReorderUseCases({ repo, uow }),
    ...createImportExportUseCases({ repo, uow, settings })
  }
}
