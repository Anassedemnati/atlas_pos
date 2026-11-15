import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mediaUrl } from '../../../src/shared/media'
import { mediaContentType, resolveMediaPath, serveMedia } from '../../../src/main/infrastructure/fs/media-files'
import { resolveTemplateMediaDir } from '../../../src/main/paths'

let root: string
let media: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-media-'))
  media = join(root, 'media')
  mkdirSync(join(media, 'products'), { recursive: true })
  writeFileSync(join(media, 'products', 'harira.webp'), 'webp-bytes')
  writeFileSync(join(media, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(media, 'notes.txt'), 'not an image')
  writeFileSync(join(root, 'secret.png'), 'secret')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('resolveMediaPath', () => {
  it('maps a media URL to a file inside the media directory', () => {
    expect(resolveMediaPath(media, 'atlas-media://local/products/harira.webp')).toBe(join(media, 'products', 'harira.webp'))
    expect(resolveMediaPath(media, 'atlas-media://local/logo.svg')).toBe(join(media, 'logo.svg'))
    expect(resolveMediaPath(media, 'atlas-media://local/products/caf%C3%A9.webp')).toBe(join(media, 'products', 'café.webp'))
  })

  // The URL parser already collapses literal and %2e dot segments (`/../x` is `/x`): those stay in the directory.
  it.each([
    'atlas-media://local/../secret.png',
    'atlas-media://local/products/../../secret.png',
    'atlas-media://local/%2e%2e/secret.png',
    'atlas-media://local//etc/passwd',
    'atlas-media://local/%2Fetc%2Fpasswd'
  ])('never leaves the media directory: %s', (url) => {
    const file = resolveMediaPath(media, url)
    expect(file === null || file.startsWith(media + sep)).toBe(true)
  })

  // An encoded slash survives the parser and is decoded here: that is a real traversal, refused.
  it.each([
    'atlas-media://local/..%2Fsecret.png',
    'atlas-media://local/%2E%2E%2Fsecret.png',
    'atlas-media://local/products%2F..%2F..%2Fsecret.png',
    'atlas-media://local/products%2F..%2F..%2F..%2Fsecret.png',
    'atlas-media://local/products\\..\\..\\secret.png',
    'atlas-media://local/products/%5C..%5C..%5Csecret.png',
    'atlas-media://local/C:%2Fwindows%2Fsystem.ini',
    'atlas-media://local/harira.webp%00.png',
    'atlas-media://local/%E0%A4%A',
    'atlas-media://local/',
    'atlas-media://local',
    'atlas-media://local/.',
    'atlas-media://local/products/..'
  ])('refuses %s', (url) => {
    expect(resolveMediaPath(media, url)).toBeNull()
  })

  it('refuses another scheme or host, and anything that is not a URL', () => {
    expect(resolveMediaPath(media, 'file:///etc/passwd')).toBeNull()
    expect(resolveMediaPath(media, 'http://local/logo.svg')).toBeNull()
    expect(resolveMediaPath(media, 'atlas-media://evil/logo.svg')).toBeNull()
    expect(resolveMediaPath(media, 'not a url')).toBeNull()
  })
})

describe('mediaContentType', () => {
  it('knows the image types, whatever the case, and nothing else', () => {
    expect(mediaContentType('a.webp')).toBe('image/webp')
    expect(mediaContentType('a.PNG')).toBe('image/png')
    expect(mediaContentType('a.jpg')).toBe('image/jpeg')
    expect(mediaContentType('a.jpeg')).toBe('image/jpeg')
    expect(mediaContentType('a.svg')).toBe('image/svg+xml')
    expect(mediaContentType('a.txt')).toBeNull()
    expect(mediaContentType('a')).toBeNull()
  })
})

describe('serveMedia', () => {
  it('serves an image with its content type', async () => {
    const res = await serveMedia(media, { url: 'atlas-media://local/products/harira.webp' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('webp-bytes')
    expect((await serveMedia(media, { url: 'atlas-media://local/logo.svg' })).headers.get('content-type')).toBe('image/svg+xml')
  })

  it('answers HEAD without a body', async () => {
    const res = await serveMedia(media, { url: 'atlas-media://local/logo.svg', method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers 404 for a traversal, a missing file, a non-image and another host', async () => {
    for (const url of [
      'atlas-media://local/../secret.png',
      'atlas-media://local/%2e%2e%2fsecret.png',
      'atlas-media://local/products/nothing.webp',
      'atlas-media://local/notes.txt',
      'atlas-media://local/products',
      'atlas-media://other/logo.svg'
    ]) {
      expect((await serveMedia(media, { url })).status, url).toBe(404)
    }
  })

  it('refuses writes, and a symlink that leads out of the media directory', async () => {
    expect((await serveMedia(media, { url: 'atlas-media://local/logo.svg', method: 'POST' })).status).toBe(405)
    symlinkSync(join(root, 'secret.png'), join(media, 'link.png'))
    expect((await serveMedia(media, { url: 'atlas-media://local/link.png' })).status).toBe(404)
  })
})

describe('mediaUrl', () => {
  it('turns a stored path (relative to the data directory) into a media URL', () => {
    expect(mediaUrl('media/products/harira.webp')).toBe('atlas-media://local/products/harira.webp')
    expect(mediaUrl('media/logo.png')).toBe('atlas-media://local/logo.png')
    expect(mediaUrl('products/x y.webp')).toBe('atlas-media://local/products/x%20y.webp')
    expect(mediaUrl(null)).toBeNull()
    expect(mediaUrl('')).toBeNull()
  })

  it('round-trips through the resolver', () => {
    expect(resolveMediaPath(media, mediaUrl('media/products/harira.webp')!)).toBe(join(media, 'products', 'harira.webp'))
  })
})

describe('resolveTemplateMediaDir', () => {
  it('is the project resources in development and the packaged resources folder otherwise', () => {
    expect(resolveTemplateMediaDir(false, '/proj', '/res')).toBe(join('/proj', 'resources', 'templates', 'media'))
    expect(resolveTemplateMediaDir(true, '/app/resources/app.asar', '/app/resources')).toBe(join('/app/resources', 'templates', 'media'))
  })
})
