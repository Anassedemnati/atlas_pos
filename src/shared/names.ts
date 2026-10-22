export type Lang = 'fr' | 'ar' | 'en'

export type LocalizedName = { fr: string; ar?: string; en?: string }

/** Name in the requested language; French is the reference copy and the fallback. */
export function pickName(n: LocalizedName, lang: Lang): string {
  return n[lang] || n.fr
}
