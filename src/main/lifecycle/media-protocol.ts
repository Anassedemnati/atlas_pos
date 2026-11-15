import { protocol } from 'electron'
import { MEDIA_SCHEME } from '@shared/media'
import { serveMedia } from '../infrastructure/fs/media-files'

/**
 * Declares the `atlas-media` scheme to Chromium. Must run BEFORE the app is ready (once, at module load).
 * Standard + secure so that pages (the Vite dev server included) may load images from it; `fetch` too.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Serves `atlas-media://local/<relative path>` from `mediaDir` and nothing else. After the app is ready. */
export function handleMediaProtocol(mediaDir: string): void {
  protocol.handle(MEDIA_SCHEME, (request) => serveMedia(mediaDir, request))
}
