import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import ar from '@shared/i18n/ar.json'
import en from '@shared/i18n/en.json'
import fr from '@shared/i18n/fr.json'
import type { Lang } from '@shared/names'

export type { Lang } from '@shared/names'

export const LANGS: readonly Lang[] = ['fr', 'ar', 'en']

/** Arabic is the one right-to-left language of the three. */
export const dirOf = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr')

const STORAGE_KEY = 'atlas.lang'
const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang)

/** The screens before a sign-in (login, recovery) speak the language last used on this till. */
function rememberedLanguage(): Lang {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    // storage unavailable: French, the reference language
  }
  return 'fr'
}

function applyToDocument(lang: Lang): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
  document.documentElement.dir = dirOf(lang)
}

const initial = rememberedLanguage()

// Resources are bundled, so initialisation is synchronous: `t()` works on the first render.
void i18next.use(initReactI18next).init({
  resources: { fr: { translation: fr }, ar: { translation: ar }, en: { translation: en } },
  lng: initial,
  fallbackLng: 'fr',
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false }
})
applyToDocument(initial)

/**
 * Switches the interface language: texts, `<html lang>` and `<html dir>` (Arabic is right-to-left).
 * The document attributes change at once; the returned promise settles when the texts are switched.
 */
export function setLanguage(lang: Lang): Promise<void> {
  applyToDocument(lang)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang)
  } catch {
    // not remembered; harmless
  }
  return i18next.changeLanguage(lang).then(() => undefined)
}

export const currentLanguage = (): Lang => (isLang(i18next.language) ? i18next.language : 'fr')

export default i18next
