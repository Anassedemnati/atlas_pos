/** The privileged scheme the main process serves `<data dir>/media` with (see `main/lifecycle/media-protocol.ts`). */
export const MEDIA_SCHEME = 'atlas-media'

/** The one host of a media URL: the scheme is a file server, not a network one. */
export const MEDIA_HOST = 'local'

/** The folder of the data directory that holds the images, as `image_path` and `business.logo` name it (`media/...`). */
export const MEDIA_DIR_NAME = 'media'

/**
 * The URL an `<img>` loads a stored image path (`media/products/harira.webp`, relative to the data directory) from:
 * `atlas-media://local/products/harira.webp`. Null for an empty path.
 */
export function mediaUrl(imagePath: string | null | undefined): string | null {
  if (!imagePath) return null
  const relative = imagePath.startsWith(`${MEDIA_DIR_NAME}/`) ? imagePath.slice(MEDIA_DIR_NAME.length + 1) : imagePath
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${relative.split('/').map(encodeURIComponent).join('/')}`
}
