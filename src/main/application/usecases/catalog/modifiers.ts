import type { ModifierGroupDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { ModifierGroupInputSchema, type ModifierGroupInput } from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface ModifierUseCases {
  /**
   * Creates (no `id`) or edits a modifier group with its modifiers. Needs `catalog.manage`. A group
   * has at least one modifier, `maxSelect >= 1` and `minSelect <= maxSelect`; a modifier's price delta
   * may be negative. On an edit the modifiers are exactly the ones listed: those with an `id` of this
   * group keep it, those without are new, the others are removed.
   */
  saveModifierGroup(session: Session, input: ModifierGroupInput): Result<{ id: string }>
}

export function createModifierUseCases(deps: { repo: CatalogRepo; uow: UnitOfWork }): ModifierUseCases {
  const { repo, uow } = deps

  function save(session: Session, raw: ModifierGroupInput): { id: string } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(ModifierGroupInputSchema, raw)
    return uow.run((tx) => {
      const existing = input.id === undefined ? undefined : repo.getModifierGroup(input.id)
      if (input.id !== undefined && !existing) throw invalidInput('id', 'unknown modifier group')
      const own = new Set(existing?.modifiers.map((m) => m.id))
      const seen = new Set<string>()
      input.modifiers.forEach((m, index) => {
        if (m.id === undefined) return
        if (!own.has(m.id)) throw invalidInput(`modifiers.${index}.id`, 'not a modifier of this group')
        if (seen.has(m.id)) throw invalidInput(`modifiers.${index}.id`, 'listed twice')
        seen.add(m.id)
      })
      const group: ModifierGroupDto = {
        id: existing?.id ?? newId(),
        name: input.name,
        minSelect: input.minSelect,
        maxSelect: input.maxSelect,
        modifiers: input.modifiers.map((m) => ({
          id: m.id ?? newId(),
          name: m.name,
          priceDeltaCents: m.priceDeltaCents
        }))
      }
      repo.saveModifierGroup(tx, group, repo.nextSort('modifierGroup'))
      logChange(tx, session, {
        type: 'modifier_group.saved',
        entity: 'modifier_group',
        entityId: group.id,
        data: { created: !existing, modifiers: group.modifiers.length }
      })
      return { id: group.id }
    })
  }

  return { saveModifierGroup: (session, input) => attemptSync(() => save(session, input)) }
}
