import type { Result } from '@shared/result'
import { ReorderSchema, type ReorderKind } from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface ReorderUseCases {
  /**
   * Needs `catalog.manage`. Puts the listed categories, products or modifier groups in that order
   * (`sort` = position). Every id must exist and none may repeat; the ones not listed keep their `sort`.
   */
  reorder(session: Session, kind: ReorderKind, ids: string[]): Result<true>
}

export function createReorderUseCases(deps: { repo: CatalogRepo; uow: UnitOfWork }): ReorderUseCases {
  const { repo, uow } = deps
  return {
    reorder: (session, kind, ids) =>
      attemptSync(() => {
        requirePermission(session, 'catalog.manage')
        const input = parseInput(ReorderSchema, { kind, ids })
        uow.run((tx) => {
          if (repo.firstMissing(input.kind, input.ids) !== undefined) throw invalidInput('ids', `unknown ${input.kind}`)
          repo.setSort(tx, input.kind, input.ids)
          logChange(tx, session, {
            type: 'catalog.reordered',
            entity: 'catalog',
            data: { kind: input.kind, count: input.ids.length }
          })
        })
        return true as const
      })
  }
}
