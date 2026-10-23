import { accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'

/** The database file inside `DataPaths.db`. */
export const DB_FILE_NAME = 'atlas.db'

/** Every directory of the data layout (all absolute), plus the database file itself. */
export interface DataPaths {
  root: string
  /** The directory `db/`: holds the database, `corrupt-<ts>.db` and `pre-restore-<ts>.db`. */
  db: string
  /** `db/atlas.db`. */
  dbFile: string
  /** `installation.json`, `wizard-draft.json`, `running.lock`. */
  config: string
  backups: string
  logs: string
  /** Virtual printer output. */
  prints: string
  /** Product images. */
  media: string
}

const LINUX_SYSTEM_DIR = '/var/lib/atlas-pos'

/** True when `dir` can hold the data: it is writable, or it does not exist yet and its parent is. */
function isUsableDir(dir: string): boolean {
  try {
    try {
      accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    accessSync(dirname(dir), constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where the installation keeps everything, by platform:
 * - `ATLAS_DATA_DIR` wins when set (tests, dev, portable installs);
 * - Windows `%ProgramData%\AtlasPOS` (`C:\ProgramData\AtlasPOS`);
 * - macOS (dev) `~/Library/Application Support/AtlasPOS`;
 * - Linux (and anything else) `/var/lib/atlas-pos`, or `~/.local/share/atlas-pos` when the system
 *   directory is not usable by this user.
 * The paths are built with the target platform's separator, so the result is right whatever the
 * host. `isUsable` is the Linux fallback test, replaceable for tests.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isUsable: (dir: string) => boolean = isUsableDir
): string {
  const override = env['ATLAS_DATA_DIR']?.trim()
  if (override) return override

  const home = env['HOME'] || homedir()
  switch (platform) {
    case 'win32':
      return win32.join(env['ProgramData'] || 'C:\\ProgramData', 'AtlasPOS')
    case 'darwin':
      return posix.join(home, 'Library', 'Application Support', 'AtlasPOS')
    default:
      return isUsable(LINUX_SYSTEM_DIR) ? LINUX_SYSTEM_DIR : posix.join(home, '.local', 'share', 'atlas-pos')
  }
}

/** Creates the data directory and its sub-directories (idempotent) and returns their absolute paths. */
export function ensureDataLayout(dir: string): DataPaths {
  const root = resolve(dir)
  const paths: DataPaths = {
    root,
    db: join(root, 'db'),
    dbFile: join(root, 'db', DB_FILE_NAME),
    config: join(root, 'config'),
    backups: join(root, 'backups'),
    logs: join(root, 'logs'),
    prints: join(root, 'prints'),
    media: join(root, 'media')
  }
  for (const sub of [paths.db, paths.config, paths.backups, paths.logs, paths.prints, paths.media]) {
    mkdirSync(sub, { recursive: true })
  }
  return paths
}
