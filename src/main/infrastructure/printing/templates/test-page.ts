import type { PrinterRow, PrintDoc } from '../types'
import { layoutDoc, type Block } from './layout'
import { formatDateTime, labelsFor } from './labels'

/** Accented letters of French and the euro sign, to see at a glance that the code page is right. */
const ACCENTS = 'éèêëàâçùûôîï €'

export interface TestPageOptions {
  businessName?: string
  /** ISO time shown on the page (defaults to now). */
  now?: string
}

/**
 * The page the wizard and the technician menu print to check a printer: who it is, how it is reached, its
 * width (a ruler as wide as the paper), accents, and the confirmation. In the printer's language.
 */
export function testPageDoc(printer: PrinterRow, opts: TestPageOptions = {}): PrintDoc {
  const L = labelsFor(printer.lang)
  const blocks: Block[] = [{ kind: 'text', text: L.testTitle, align: 'center', bold: true, size: { w: 1, h: 2 } }]
  if (opts.businessName) blocks.push({ kind: 'text', text: opts.businessName, align: 'center', bold: true })
  blocks.push({ kind: 'rule' })
  blocks.push({ kind: 'text', text: `${L.testPrinter} : ${printer.name}` })
  blocks.push({ kind: 'text', text: `${L.testKind} : ${printer.kind}` })
  if (printer.address) blocks.push({ kind: 'text', text: `${L.testAddress} : ${printer.address}` })
  blocks.push({ kind: 'text', text: `${L.testWidth} : ${printer.widthMm} mm` })
  blocks.push({ kind: 'text', text: formatDateTime(opts.now ?? new Date().toISOString()) })
  blocks.push({ kind: 'rule' })
  blocks.push({ kind: 'ruler' })
  blocks.push({ kind: 'text', text: ACCENTS })
  blocks.push({ kind: 'rule' })
  blocks.push({ kind: 'text', text: L.testOk, align: 'center', bold: true, size: { w: 1, h: 2 } })
  return layoutDoc(blocks, {
    lang: printer.lang,
    widthMm: printer.widthMm,
    raster: printer.raster,
    paper: printer.kind === 'os-html'
  })
}
