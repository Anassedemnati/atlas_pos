import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Result } from '../../src/shared/result'
import type { WizardPatch } from '../../src/shared/setup/draft'
import { createEventBus } from '../../src/main/application/events'
import { createSetupService, type SetupDeps, type SetupService } from '../../src/main/application/usecases/setup'
import type { Logger } from '../../src/main/logger'
import { ensureDataLayout, type DataPaths } from '../../src/main/paths'

export const log = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() })

/** A setup service on a data directory, with a bus, a silent log and no rendering (virtual French printers need none). */
export function testSetupService(
  deps: Pick<SetupDeps, 'paths'> & Partial<Omit<SetupDeps, 'paths'>>
): SetupService {
  return createSetupService({
    clock: { now: () => new Date() },
    bus: createEventBus(),
    log: log(),
    appVersion: '0.1.0-test',
    rasterize: async () => {
      throw new Error('no rendering in tests')
    },
    setAutostart: () => {},
    restore: async () => ({ ok: false, error: { code: 'restore_unavailable', messageKey: 'errors.restore_unavailable' } }) as Result<{ route: string }>,
    ...deps
  })
}

export interface SetupEnv {
  paths: DataPaths
  /** An empty folder to use as a `disk` backup destination. */
  backupDir: string
  root: string
  cleanup(): void
}

/** A new, empty installation directory and a backup folder. */
export function setupEnv(): SetupEnv {
  const root = mkdtempSync(join(tmpdir(), 'atlas-setup-'))
  const paths = ensureDataLayout(join(root, 'data'))
  const backupDir = join(root, 'backup-disk')
  mkdirSync(backupDir)
  return { paths, backupDir, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export const LEGAL = {
  raisonSociale: 'Café Atlas SARL',
  nomCommercial: 'Café Atlas',
  adresse: '12 avenue Hassan II',
  ville: 'Casablanca',
  telephone: '0522000000',
  ice: '001234567000012',
  if: '12345678',
  rc: '123456',
  patente: '31234567'
}

export const MANAGER_PIN = '1234'
export const MANAGER_PASSWORD = 'Atlas-Secret-2026'
export const TECH_CODE = '654321'

/** Everything a finished wizard holds, valid for any template. Virtual printers, one local backup destination. */
export function completeDraft(env: SetupEnv, over: WizardPatch = {}): WizardPatch {
  return {
    step: 7,
    legal: LEGAL,
    printers: [
      { tempId: 'till', name: 'Caisse', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'receipt', active: true },
      { tempId: 'kitchen', name: 'Cuisine', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'kitchen', active: true },
      { tempId: 'bar', name: 'Bar', kind: 'virtual', address: '', widthMm: 80, lang: 'fr', raster: false, role: 'bar', active: true }
    ],
    users: [{ displayName: 'Karim', pin: MANAGER_PIN, profileCode: 'gerant', username: 'karim', password: MANAGER_PASSWORD }],
    technicianCode: TECH_CODE,
    backups: [{ role: 'disk', path: env.backupDir, label: 'Disque 2' }],
    ...over
  }
}
