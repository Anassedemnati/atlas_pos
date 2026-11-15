import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { RECEIPT_FONT } from '../templates/layout'

const SUBSETS = ['arabic', 'latin'] as const
const WEIGHTS = [400, 700] as const

let cached: string | undefined

/**
 * `@font-face` rules for IBM Plex Sans Arabic (Arabic and Latin subsets, regular and bold) with the font files
 * inlined as data URIs: printing works offline and from inside the packaged app, whatever fonts the machine has.
 * Empty (system fonts then) when the package cannot be read.
 */
export function receiptFontCss(): string {
  if (cached !== undefined) return cached
  try {
    const root = dirname(createRequire(import.meta.url).resolve('@fontsource/ibm-plex-sans-arabic/package.json'))
    const ranges = JSON.parse(readFileSync(join(root, 'unicode.json'), 'utf8')) as Record<string, string>
    const rules: string[] = []
    for (const subset of SUBSETS) {
      for (const weight of WEIGHTS) {
        const file = readFileSync(join(root, 'files', `ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`))
        rules.push(
          `@font-face{font-family:'${RECEIPT_FONT}';font-style:normal;font-weight:${weight};` +
            `src:url(data:font/woff2;base64,${file.toString('base64')}) format('woff2');unicode-range:${ranges[subset]}}`
        )
      }
    }
    cached = rules.join('\n')
  } catch (error) {
    // Printing goes on with whatever fonts the machine has; Arabic may then come out as boxes.
    console.warn('[printing] the receipt fonts could not be read, using the system fonts', error)
    cached = ''
  }
  return cached
}

/** The document with the receipt fonts embedded in its head. */
export function withReceiptFonts(html: string): string {
  const css = receiptFontCss()
  if (css === '') return html
  const style = `<style>${css}</style>`
  return html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : style + html
}
