import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The till screens keep their texts next to them (`features/<name>/i18n/{fr,ar,en}.json`). Every static `t('key')`
// of a till feature must exist in French (or in the shared catalogue), and the three languages must agree.

const FEATURES = ['till', 'login', 'order', 'floor', 'payment', 'closure', 'recovery', 'display', 'tickets', 'tech']
const root = resolve('src/renderer/features')

const flatten = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((all, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'object' && value !== null ? { ...all, ...flatten(value as Record<string, unknown>, path) } : { ...all, [path]: String(value) }
  }, {})

const bundle = (feature: string, lang: string): Record<string, string> =>
  flatten(JSON.parse(readFileSync(join(root, feature, 'i18n', `${lang}.json`), 'utf8')))

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort()

describe('till feature texts', () => {
  const shared = flatten(JSON.parse(readFileSync(resolve('src/shared/i18n/fr.json'), 'utf8')))
  const known = new Set([...Object.keys(shared), ...FEATURES.flatMap((feature) => Object.keys(bundle(feature, 'fr')))])

  it('every static key used by a till screen has a French text', () => {
    const missing: string[] = []
    for (const feature of FEATURES) {
      for (const file of sources(join(root, feature))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
          if (!known.has(match[1]!)) missing.push(`${feature}: ${match[1]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it.each(FEATURES)('%s has the same keys and placeholders in French, Arabic and English', (feature) => {
    const fr = bundle(feature, 'fr')
    for (const lang of ['ar', 'en']) {
      const other = bundle(feature, lang)
      expect(Object.keys(other).sort(), `${feature} ${lang}`).toEqual(Object.keys(fr).sort())
      for (const [key, text] of Object.entries(fr)) {
        expect(text.trim(), key).not.toBe('')
        expect(placeholders(other[key]!), `${lang} ${key}`).toEqual(placeholders(text))
      }
    }
  })
})
