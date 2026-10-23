import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { defaultDraft, WizardDraftSchema, type WizardDraft } from '@shared/setup/draft'
import { readJsonSafe, writeFileAtomic } from '../../../infrastructure/fs/atomic'
import { ProfileSchema, type Profile } from '../../../infrastructure/profile/profile-io'
import type { DataPaths } from '../../../paths'

/**
 * The wizard's files, all in `config/`: the draft, the loaded `.atlasprofile`, the copies of the import
 * sheet and of the logo (the draft refers to the copies, never to a path the renderer sent), and the
 * attempt marker of `finishSetup`.
 */
export interface DraftStore {
  /** The saved draft, or a new one when there is none (or it cannot be read). */
  read(): WizardDraft
  /** Atomic: a power cut leaves the old draft or the new one. */
  write(draft: WizardDraft): void
  loadedProfile(): Profile | null
  saveProfile(profile: Profile): void
  /** Keeps `data` as `config/wizard-<kind>.<ext>` (replacing an earlier copy) and returns its path. */
  stash(kind: 'import' | 'logo', ext: string, data: Uint8Array): string
  /** True for a path inside `config/`. */
  isOwnFile(path: string): boolean
  /** Deletes the draft and every file that belongs to it. */
  clear(): void
  attemptFile: string
}

const DRAFT = 'wizard-draft.json'
const PROFILE = 'wizard-profile.json'

export function createDraftStore(paths: Pick<DataPaths, 'config'>): DraftStore {
  const file = (name: string): string => join(paths.config, name)
  const stashed = (kind: 'import' | 'logo'): string[] =>
    readdirSync(paths.config).filter((name) => name.startsWith(`wizard-${kind}.`))
  const removeStashed = (kind: 'import' | 'logo'): void => {
    for (const name of stashed(kind)) rmSync(file(name), { force: true })
  }

  return {
    attemptFile: file('setup-attempt.json'),
    read() {
      const draft = readJsonSafe(file(DRAFT), WizardDraftSchema)
      return draft ?? defaultDraft()
    },
    write(draft) {
      mkdirSync(paths.config, { recursive: true })
      writeFileAtomic(file(DRAFT), `${JSON.stringify(WizardDraftSchema.parse(draft), null, 2)}\n`)
    },
    loadedProfile: () => readJsonSafe(file(PROFILE), ProfileSchema as z.ZodType<Profile>),
    saveProfile(profile) {
      mkdirSync(paths.config, { recursive: true })
      writeFileAtomic(file(PROFILE), JSON.stringify(profile))
    },
    stash(kind, ext, data) {
      mkdirSync(paths.config, { recursive: true })
      removeStashed(kind)
      const target = file(`wizard-${kind}.${ext}`)
      writeFileAtomic(target, data)
      return target
    },
    isOwnFile: (path) => resolve(path).startsWith(`${resolve(paths.config)}${sep}wizard-`),
    clear() {
      for (const name of [DRAFT, PROFILE]) rmSync(file(name), { force: true })
      removeStashed('import')
      removeStashed('logo')
    }
  }
}
