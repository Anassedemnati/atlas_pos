import type { CategoryDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { DEFAULT_CATEGORY_COLOR, IdRule } from '../../../domain/catalog/fields'
import { CategoryInputSchema, type CategoryInput } from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface CategoryUseCases {
  /**
   * Creates (no `id`) or edits a category. Needs `catalog.manage`. A new category goes last and gets
   * the default colour unless one is given; on an edit a field left out is kept.
   */
  saveCategory(session: Session, input: CategoryInput): Result<{ id: string }>
  /** Needs `catalog.manage`. A category that still has products, inactive ones included, is `category_not_empty`. */
  deleteCategory(session: Session, id: string): Result<{ id: string }>
}

export function createCategoryUseCases(deps: { repo: CatalogRepo; uow: UnitOfWork }): CategoryUseCases {
  const { repo, uow } = deps

  function save(session: Session, raw: CategoryInput): { id: string } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(CategoryInputSchema, raw)
    return uow.run((tx) => {
      const existing = input.id === undefined ? undefined : repo.getCategory(input.id)
      if (input.id !== undefined && !existing) throw invalidInput('id', 'unknown category')
      const category: CategoryDto = {
        id: existing?.id ?? newId(),
        name: input.name,
        color: input.color ?? existing?.color ?? DEFAULT_CATEGORY_COLOR,
        sort: existing?.sort ?? repo.nextSort('category'),
        active: input.active ?? existing?.active ?? true,
        imagePath: input.imagePath === undefined ? (existing?.imagePath ?? null) : input.imagePath
      }
      if (existing) repo.updateCategory(tx, category)
      else repo.insertCategory(tx, category)
      logChange(tx, session, {
        type: 'category.saved',
        entity: 'category',
        entityId: category.id,
        data: { created: !existing }
      })
      return { id: category.id }
    })
  }

  function remove(session: Session, rawId: string): { id: string } {
    requirePermission(session, 'catalog.manage')
    const id = parseInput(IdRule, rawId)
    return uow.run((tx) => {
      const category = repo.getCategory(id)
      if (!category) throw invalidInput('id', 'unknown category')
      if (repo.countProductsInCategory(id) > 0) throw new AppErrorException('category_not_empty')
      repo.deleteCategory(tx, id)
      logChange(tx, session, { type: 'category.deleted', entity: 'category', entityId: id, data: { name: category.name.fr } })
      return { id }
    })
  }

  return {
    saveCategory: (session, input) => attemptSync(() => save(session, input)),
    deleteCategory: (session, id) => attemptSync(() => remove(session, id))
  }
}
