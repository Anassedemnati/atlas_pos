import type { Lang } from '@shared/names'
import { EscPos, columnsFor, type Align } from '../escpos'
import { dotsFor } from '../raster'
import type { PrintDoc } from '../types'

/**
 * A document as blocks, rendered twice from the same content: as ESC/POS text for a thermal printer, or
 * as HTML (rasterised for an image printer and for Arabic, or sent to a system printer). The templates
 * only build blocks, so what is printed cannot differ between the two paths.
 */
export interface TextSize {
  w: 1 | 2
  h: 1 | 2
}

export type Block =
  | { kind: 'text'; text: string; align?: Align; bold?: boolean; size?: TextSize }
  | { kind: 'row'; left: string; right: string; bold?: boolean; size?: TextSize }
  /**
   * `whole` as one line when it fits the paper in text mode, otherwise `rows` (two columns each); HTML
   * always uses `rows`.
   */
  | { kind: 'fit'; whole: string; rows: [string, string][] }
  | { kind: 'rule'; heavy?: boolean }
  | { kind: 'gap' }
  /** An image (a data URI); only printed in HTML, never in text mode. */
  | { kind: 'logo'; src: string }
  /** `1234567890...` as wide as the paper, to check the width. */
  | { kind: 'ruler' }

export interface LayoutOptions {
  lang: Lang
  widthMm: number
  /** Print as an image (HTML to rasterise), whatever the language. */
  raster?: boolean
  /** HTML sized in millimetres for a system printer. */
  paper?: boolean
}

const ruler = (columns: number): string => '1234567890'.repeat(Math.ceil(columns / 10)).slice(0, columns)

/** The ESC/POS job: reset, CP858, the blocks, a feed and the cut. */
export function blocksToEscPos(blocks: Block[], widthMm: number): Buffer {
  const doc = new EscPos({ widthMm }).init().codepage()
  const styled = (b: { align?: Align; bold?: boolean; size?: TextSize }, write: () => void): void => {
    doc.align(b.align ?? 'left')
    if (b.bold) doc.bold(true)
    if (b.size) doc.size(b.size.w, b.size.h)
    write()
    if (b.size) doc.size(1, 1)
    if (b.bold) doc.bold(false)
  }
  for (const b of blocks) {
    switch (b.kind) {
      case 'text':
        styled(b, () => doc.text(b.text))
        break
      case 'row':
        styled(b, () => doc.line([b.left, b.right]))
        break
      case 'fit':
        doc.align('left')
        if (b.whole.length <= doc.columns) doc.text(b.whole)
        else for (const [left, right] of b.rows) doc.line([left, right])
        break
      case 'rule':
        doc.align('left').text((b.heavy ? '=' : '-').repeat(doc.columns))
        break
      case 'gap':
        doc.text('')
        break
      case 'ruler':
        doc.align('left').text(ruler(doc.columns))
        break
      case 'logo':
        break
    }
  }
  return doc.align('left').feed(3).cut().build()
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The typeface the raster path names; the Electron adapter embeds its font files under this name. */
export const RECEIPT_FONT = 'IBM Plex Sans Arabic'

export const FONT_STACK = `'${RECEIPT_FONT}', 'Segoe UI', Tahoma, 'Noto Sans Arabic', 'DejaVu Sans', Arial, sans-serif`

/** One thermal dot is 1/8 mm (203 dpi): a bitmap is laid out in CSS pixels = dots, a paper job in mm. */
const sizes = (paper: boolean): ((dots: number) => string) =>
  paper ? (dots) => `${+(dots / 8).toFixed(2)}mm` : (dots) => `${dots}px`

const sizeClass = (s?: TextSize): string => (s && (s.w === 2 || s.h === 2) ? (s.w === 2 && s.h === 2 ? ' s2' : ' s15') : '')

/** The HTML document of the blocks, `dots` wide (576 for 80 mm, 384 for 58 mm), the printable width. */
export function blocksToHtml(blocks: Block[], opts: { lang: Lang; widthMm: number; paper?: boolean }): string {
  const u = sizes(opts.paper === true)
  const dots = dotsFor(opts.widthMm)
  const columns = columnsFor(opts.widthMm)
  // Each string is isolated and takes the direction of its own first letter (`<bdi>`), so "12 rue Tarik" or a
  // French product name keeps its order inside an Arabic ticket, while the block follows the document's direction.
  const cell = (text: string): string => `<span><bdi>${escapeHtml(text)}</bdi></span>`
  const row = (left: string, right: string, cls = ''): string => `<div class="r${cls}">${cell(left)}${cell(right)}</div>`
  const body = blocks
    .map((b) => {
      switch (b.kind) {
        case 'text':
          return `<div class="t${b.align === 'center' ? ' c' : b.align === 'right' ? ' e' : ''}${b.bold ? ' b' : ''}${sizeClass(b.size)}"><bdi>${escapeHtml(b.text)}</bdi></div>`
        case 'row':
          return row(b.left, b.right, `${b.bold ? ' b' : ''}${sizeClass(b.size)}`)
        case 'fit':
          return b.rows.map(([left, right]) => row(left, right)).join('')
        case 'rule':
          return `<hr class="${b.heavy ? 'h' : ''}">`
        case 'gap':
          return '<div class="g"></div>'
        case 'logo':
          return `<img class="logo" src="${escapeHtml(b.src)}" alt="">`
        case 'ruler':
          return `<div class="ruler" dir="ltr">${ruler(columns)}</div>`
      }
    })
    .join('\n')
  // A monospace advance is 0.6 em: this font size makes the ruler exactly as wide as the paper.
  const rulerSize = u(Math.floor(dots / columns / 0.6))
  return `<!doctype html>
<html lang="${opts.lang}" dir="${opts.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;padding:0;background:#fff;color:#000}
body{width:${u(dots)};font-family:${FONT_STACK};font-size:${u(22)};line-height:1.3;-webkit-font-smoothing:none}
.t{white-space:pre-wrap;overflow-wrap:anywhere}
.c{text-align:center}
.e{text-align:end}
.b{font-weight:700}
.s2{font-size:2em;line-height:1.15}
.s15{font-size:1.5em;line-height:1.2}
.r{display:flex;justify-content:space-between;align-items:baseline;gap:${u(12)}}
.r>span:first-child{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.r>span:last-child{flex:none;white-space:nowrap}
hr{border:0;border-top:${u(2)} dashed #000;margin:${u(6)} 0}
hr.h{border-top-style:solid;border-top-width:${u(3)}}
.g{height:${u(14)}}
img.logo{display:block;margin:0 auto ${u(8)};max-width:60%;max-height:${u(160)}}
.ruler{font-family:monospace;font-size:${rulerSize};white-space:nowrap;overflow:hidden}
</style>
</head>
<body>
${body}
</body>
</html>
`
}

/**
 * The document in the form its printer needs: HTML in millimetres for a system printer (`paper`), HTML to
 * rasterise for an image printer or Arabic, ESC/POS text otherwise. Arabic text has no usable code page on
 * most printers, so it always goes through the image path.
 */
export function layoutDoc(blocks: Block[], o: LayoutOptions): PrintDoc {
  if (o.paper) return { html: blocksToHtml(blocks, { lang: o.lang, widthMm: o.widthMm, paper: true }), raster: false, widthMm: o.widthMm }
  if (o.raster || o.lang === 'ar') {
    return { html: blocksToHtml(blocks, { lang: o.lang, widthMm: o.widthMm }), raster: true, widthMm: o.widthMm }
  }
  return { escpos: blocksToEscPos(blocks, o.widthMm) }
}
