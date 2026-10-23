import type { LoadedProfileDto, SetupProfileSummaryDto, SetupTemplateDto } from '@shared/dto'
import type { MODULES } from '@shared/modules'
import { BUSINESS_TYPES } from '../../../domain/config/settings-registry'
import { loadTemplate, type PermissionProfile } from '../../../domain/config/template'
import type { Profile } from '../../../infrastructure/profile/profile-io'

const summary = (p: PermissionProfile): SetupProfileSummaryDto => ({ code: p.code, name: p.name, permissions: p.permissions, maxDiscountBp: p.max_discount_bp })

/** The four business templates, for the cards of the "Type d'activité" step. */
export function listTemplates(): SetupTemplateDto[] {
  return BUSINESS_TYPES.map((id) => {
    const t = loadTemplate(id)
    return {
      id,
      version: t.version,
      modules: t.modules as Record<(typeof MODULES)[number], boolean>,
      counts: {
        categories: t.categories.length,
        products: t.products.length,
        modifierGroups: t.modifierGroups.length,
        menus: t.menus.length,
        rooms: t.rooms.length,
        tables: t.tables.length,
        paymentMethods: t.paymentMethods.length,
        profiles: t.profiles.length
      },
      categories: t.categories.map((c) => ({ code: c.code, name: c.name, color: c.color, route: t.printersRouting[c.code] ?? null })),
      profiles: t.profiles.map(summary)
    }
  })
}

export function describeProfile(p: Profile): LoadedProfileDto {
  return {
    createdAt: p.createdAt,
    appVersion: p.appVersion,
    counts: {
      categories: p.catalog.categories.length,
      products: p.catalog.products.length,
      modifierGroups: p.catalog.modifierGroups.length,
      menus: p.catalog.menus.length,
      rooms: p.rooms.length,
      tables: p.tables.length,
      paymentMethods: p.paymentMethods.length,
      profiles: p.profiles.length
    },
    categories: p.catalog.categories.map((c) => ({ code: c.code, name: c.name, color: c.color })),
    profiles: p.profiles.map(summary)
  }
}
