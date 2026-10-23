import type { MenuDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { MenuInputSchema, type MenuInput } from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface MenuUseCases {
  /**
   * Creates or replaces the set menu of a product (the product carries the price). Needs
   * `catalog.manage`. A menu has at least one course, a course at least one item; an item is another
   * existing product, once per course. Saving again replaces the courses and keeps the menu's id.
   */
  saveMenu(session: Session, input: MenuInput): Result<{ id: string }>
}

export function createMenuUseCases(deps: { repo: CatalogRepo; uow: UnitOfWork }): MenuUseCases {
  const { repo, uow } = deps

  function save(session: Session, raw: MenuInput): { id: string } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(MenuInputSchema, raw)
    return uow.run((tx) => {
      if (!repo.getProduct(input.productId)) throw invalidInput('productId', 'unknown product')
      input.courses.forEach((course, c) => {
        const seen = new Set<string>()
        course.items.forEach((item, i) => {
          const field = `courses.${c}.items.${i}.productId`
          if (item.productId === input.productId) throw invalidInput(field, 'a menu cannot offer itself')
          if (!repo.getProduct(item.productId)) throw invalidInput(field, 'unknown product')
          if (seen.has(item.productId)) throw invalidInput(field, 'listed twice')
          seen.add(item.productId)
        })
      })
      const existingId = repo.findMenuByProduct(input.productId)
      const menu: MenuDto = {
        id: existingId ?? newId(),
        productId: input.productId,
        courses: input.courses.map((course) => ({ id: newId(), ...course }))
      }
      repo.saveMenu(tx, menu)
      logChange(tx, session, {
        type: 'menu.saved',
        entity: 'menu',
        entityId: menu.id,
        data: { created: existingId === undefined, productId: menu.productId, courses: menu.courses.length }
      })
      return { id: menu.id }
    })
  }

  return { saveMenu: (session, input) => attemptSync(() => save(session, input)) }
}
