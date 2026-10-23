import { realpath, readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { MEDIA_HOST, MEDIA_SCHEME } from '@shared/media'

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
}

/** The content type of a media file by its extension, or null when it is not an image we serve. */
export function mediaContentType(file: string): string | null {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? null
}

/** True when `file` is strictly inside `root` (both absolute). */
function isInside(root: string, file: string): boolean {
  const inside = relative(root, file)
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/**
 * The file `atlas-media://local/<relative path>` names inside `mediaDir`, or null when the URL is not one of ours or
 * would leave the directory (`..`, an encoded `%2f`, a backslash, a colon, a NUL). Pure: the file
 * is not looked at.
 */
export function resolveMediaPath(mediaDir: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  const wanted = decoded.replace(/^\/+/, '')
  // A colon is a Windows drive or an NTFS stream; none of our file names has one.
  if (wanted === '' || /[\0\\:]/.test(wanted)) return null
  const root = resolve(mediaDir)
  const file = resolve(root, wanted)
  return isInside(root, file) ? file : null
}

const NOT_FOUND = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })

/**
 * The response of the `atlas-media` protocol: the image, or 404 for everything else (not our URL, outside the media
 * directory, a symlink leading out of it, not an image type, a missing file). GET and HEAD only.
 */
export async function serveMedia(mediaDir: string, request: { url: string; method?: string }): Promise<Response> {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  const file = resolveMediaPath(mediaDir, request.url)
  const type = file ? mediaContentType(file) : null
  if (!file || !type) return NOT_FOUND()
  try {
    // A symlink inside the directory must not lead out of it.
    const real = await realpath(file)
    if (!isInside(await realpath(mediaDir), real)) return NOT_FOUND()
    const body = await readFile(real)
    return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(body.byteLength),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        // An SVG opened as a document must not run anything.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      }
    })
  } catch {
    return NOT_FOUND()
  }
}
