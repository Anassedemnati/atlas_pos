// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import i18n, { dirOf, setLanguage } from '../../../src/renderer/app/i18n'

const load = (lang: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(`src/shared/i18n/${lang}.json`), 'utf8'))

/** `a.b.c` for every leaf. */
const flatten = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((all, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'object' && value !== null ? { ...all, ...flatten(value as Record<string, unknown>, path) } : { ...all, [path]: String(value) }
  }, {})

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]!).sort()

describe('language files', () => {
  const fr = flatten(load('fr'))
  const ar = flatten(load('ar'))
  const en = flatten(load('en'))

  it('have the same keys in French, Arabic and English', () => {
    const keys = Object.keys(fr).sort()
    expect(Object.keys(ar).sort()).toEqual(keys)
    expect(Object.keys(en).sort()).toEqual(keys)
  })

  it('leave no text empty and use the same placeholders in every language', () => {
    for (const [key, text] of Object.entries(fr)) {
      expect(text.trim(), key).not.toBe('')
      expect(ar[key]?.trim(), `ar ${key}`).not.toBe('')
      expect(en[key]?.trim(), `en ${key}`).not.toBe('')
      expect(placeholders(ar[key]!), `ar ${key}`).toEqual(placeholders(text))
      expect(placeholders(en[key]!), `en ${key}`).toEqual(placeholders(text))
    }
  })
})

describe('setLanguage', () => {
  afterEach(() => setLanguage('fr'))

  it('turns the page right-to-left for Arabic and back for the others', async () => {
    await setLanguage('ar')
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
    expect(i18n.t('common.save')).toBe('حفظ')

    await setLanguage('en')
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(i18n.t('common.save')).toBe('Save')
  })

  it('sets the direction at once, without waiting for the promise', () => {
    void setLanguage('ar')
    expect(document.documentElement.dir).toBe('rtl')
    expect(dirOf('fr')).toBe('ltr')
  })
})
