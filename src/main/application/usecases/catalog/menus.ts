import type { MenuDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { MenuInputSchema, type MenuInput } from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface MenuUseCases {
  /**
   * Creates or replaces the set menu of a product (the product carries the price). Needs
   * `catalog.manage`. A menu has at least one course, a course at least one item; an item is another
   * existing product, once per course. A menu may not offer itself, nor (through other menus) a product
   * whose menu offers it back: `menu_cycle`. Saving again replaces the courses and keeps the menu's id.
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
      // The menus as they will be once this one is saved.
      const graph = repo.menuGraph()
      graph.set(
        input.productId,
        input.courses.flatMap((course) => course.items.map((item) => item.productId))
      )
      const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
        if (from === target) return true
        if (visited.has(from)) return false
        visited.add(from)
        return (graph.get(from) ?? []).some((next) => reaches(next, target, visited))
      }
      input.courses.forEach((course, c) => {
        const seen = new Set<string>()
        course.items.forEach((item, i) => {
          const field = `courses.${c}.items.${i}.productId`
          if (!repo.getProduct(item.productId)) throw invalidInput(field, 'unknown product')
          if (seen.has(item.productId)) throw invalidInput(field, 'listed twice')
          seen.add(item.productId)
          if (reaches(item.productId, input.productId)) throw new AppErrorException('menu_cycle', { field })
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
