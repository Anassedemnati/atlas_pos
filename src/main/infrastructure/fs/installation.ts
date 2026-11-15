import { join } from 'node:path'
import { z } from 'zod'
import type { DataPaths } from '../../paths'
import { readJsonSafe, writeFileAtomic } from './atomic'

/** `config/installation.json`: who this installation is and whether its setup wizard finished. */
export const InstallationSchema = z.object({
  installationId: z.string().min(1),
  createdAt: z.string().min(1),
  /** null until `finishSetup` completes: a start with `null` goes back to the wizard. */
  setupCompletedAt: z.string().min(1).nullable(),
  appVersion: z.string().min(1)
})

export type Installation = z.infer<typeof InstallationSchema>

const installationFile = (paths: Pick<DataPaths, 'config'>): string => join(paths.config, 'installation.json')

/** The installation file, or null when it is missing or invalid. */
export function readInstallation(paths: Pick<DataPaths, 'config'>): Installation | null {
  return readJsonSafe(installationFile(paths), InstallationSchema)
}

export function writeInstallation(paths: Pick<DataPaths, 'config'>, installation: Installation): void {
  writeFileAtomic(installationFile(paths), `${JSON.stringify(InstallationSchema.parse(installation), null, 2)}\n`)
}
