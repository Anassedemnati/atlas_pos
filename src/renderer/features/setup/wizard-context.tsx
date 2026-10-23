import { createContext, useContext } from 'react'
import type { LoadedProfileDto, ParsedCatalogSheet, SetupTemplateDto } from '@shared/dto'
import type { WizardDraft } from '@shared/setup/draft'
import type { Api } from '../../app/api'

export type DraftEdit = Partial<WizardDraft> | ((draft: WizardDraft) => Partial<WizardDraft>)

export interface WizardContextValue {
  /** The draft as the screen shows it: the saved one plus what is typed since the last save. */
  draft: WizardDraft
  /** The saved draft (what the main process holds). */
  saved: WizardDraft
  profile: LoadedProfileDto | null
  templates: SetupTemplateDto[]
  api: Api
  /** Changes the working draft (not saved until "Suivant"). Clears the errors of the fields it touches. */
  edit: (change: DraftEdit) => void
  /** Field errors (server field path -> message). */
  errors: Record<string, string>
  setErrors: (errors: Record<string, string>) => void
  /** Replaces the saved draft with the main process's answer (a profile applied, a logo picked). */
  adopt: (state: { draft: WizardDraft; profile: LoadedProfileDto | null }, options?: { keepEdits?: boolean }) => void
  /** Moves to a step, saving only the step number (no validation). */
  goTo: (step: number) => Promise<boolean>
  busy: boolean
  /** Step 2: what the last Excel/CSV preview found. */
  importPreview: ParsedCatalogSheet | null
  setImportPreview: (preview: ParsedCatalogSheet | null) => void
  importName: string
  setImportName: (name: string) => void
  /** Step 5: the technician code typed a second time. */
  techConfirm: string
  setTechConfirm: (value: string) => void
}

export const WizardContext = createContext<WizardContextValue | null>(null)

export function useWizard(): WizardContextValue {
  const value = useContext(WizardContext)
  if (!value) throw new Error('useWizard: outside the setup wizard')
  return value
}
