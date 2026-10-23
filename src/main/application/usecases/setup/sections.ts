import type { WizardDraft } from '@shared/setup/draft'
import { loadTemplate, type Sections, type Template } from '../../../domain/config/template'
import type { Profile } from '../../../infrastructure/profile/profile-io'

/** What a setup is built from besides the draft: the business template and the profile loaded into the wizard, if any. */
export interface SetupSource {
  template: Template
  profile: Profile | null
}

export function sourceOf(draft: WizardDraft, loadedProfile: Profile | null): SetupSource {
  return { template: loadTemplate(draft.businessType), profile: loadedProfile }
}

const sectionsOfProfile = (p: Profile): Sections => ({ ...p.catalog, rooms: p.rooms, tables: p.tables, paymentMethods: p.paymentMethods, profiles: p.profiles })
const sectionsOfTemplate = (t: Template): Sections => ({
  categories: t.categories,
  products: t.products,
  modifierGroups: t.modifierGroups,
  menus: t.menus,
  rooms: t.rooms,
  tables: t.tables,
  paymentMethods: t.paymentMethods,
  profiles: t.profiles
})

/**
 * The sections the setup seeds: a loaded profile's (catalogue source `profile`), else the template's. With
 * an import or an empty catalogue, the products come from elsewhere (see `seedCatalog`), so the catalogue
 * sections are empty, but rooms, payment methods and profiles still come from the template.
 */
export function sectionsFor(draft: WizardDraft, source: SetupSource): Sections {
  const from = draft.catalogSource === 'profile' && source.profile ? sectionsOfProfile(source.profile) : sectionsOfTemplate(source.template)
  if (draft.catalogSource === 'import' || draft.catalogSource === 'empty') {
    return { ...from, categories: [], products: [], modifierGroups: [], menus: [] }
  }
  return from
}
