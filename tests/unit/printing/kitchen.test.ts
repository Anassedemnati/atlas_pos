import { describe, expect, it } from 'vitest'
import { kitchenDoc, type KitchenLine, type KitchenOrderInfo } from '../../../src/main/infrastructure/printing/templates/kitchen'
import { paperLines, paperText } from '../../helpers/escpos-decode'

const order: KitchenOrderInfo = {
  type: 'dine_in',
  tableLabel: 'T4',
  covers: 3,
  orderNumber: null,
  waiter: 'Amine',
  at: new Date(2026, 9, 22, 12, 30).toISOString(),
  note: ''
}

const line = (over: Partial<KitchenLine> & { fr: string; ar?: string }): KitchenLine => ({
  id: over.id ?? over.fr,
  name: { fr: over.fr, ar: over.ar },
  qtyMilli: over.qtyMilli ?? 1000,
  modifiers: over.modifiers ?? [],
  note: over.note ?? '',
  course: over.course ?? 0
})

const OPTS = { lang: 'fr', widthMm: 80 } as const
const escpos = (doc: ReturnType<typeof kitchenDoc>): Buffer => {
  if (!('escpos' in doc)) throw new Error('expected ESC/POS')
  return doc.escpos
}

describe('kitchenDoc', () => {
  it('prints the table, covers, waiter and time, then the lines with their modifiers and notes', () => {
    const lines = [
      line({ fr: 'Tajine', qtyMilli: 2000 }),
      line({ fr: 'Brochettes', modifiers: [{ name: { fr: 'Bien cuit' } }], note: 'sans oignon' })
    ]
    const text = paperText(escpos(kitchenDoc(order, lines, OPTS)))
    expect(text).toContain('Table T4')
    expect(text).toContain('Couverts : 3')
    expect(text).toContain('Serveur : Amine')
    expect(text).toContain('22/10/2026 12:30')
    expect(text).toContain('2 x Tajine')
    expect(text).toContain('1 x Brochettes')
    expect(text).toContain('  + Bien cuit')
    expect(text).toContain('  > sans oignon')
  })

  it('prints the lines in large type: double height and bold, the table in double size', () => {
    const hex = escpos(kitchenDoc(order, [line({ fr: 'Tajine' })], OPTS)).toString('hex')
    expect(hex).toContain('1d2111') // GS ! 0x11: the table, double width and height
    expect(hex).toContain('1d2101') // GS ! 0x01: the lines, double height
    expect(hex).toContain('1b4501') // bold
  })

  it('marks a cancellation ANNULÉ', () => {
    const text = paperText(escpos(kitchenDoc(order, [line({ fr: 'Tajine' })], { ...OPTS, cancelled: true })))
    expect(text).toContain('*** ANNULÉ ***')
    expect(text).toContain('1 x Tajine')
    expect(paperText(escpos(kitchenDoc(order, [line({ fr: 'Tajine' })], OPTS)))).not.toContain('ANNULÉ')
  })

  it('marks a ticket sent again after it may have printed RÉIMPRESSION', () => {
    const text = paperText(escpos(kitchenDoc(order, [line({ fr: 'Tajine' })], { ...OPTS, reprint: true })))
    expect(text).toContain('*** RÉIMPRESSION ***')
    expect(paperText(escpos(kitchenDoc(order, [line({ fr: 'Tajine' })], OPTS)))).not.toContain('RÉIMPRESSION')
  })

  it('groups by course, with a heading once there is more than one', () => {
    const lines = [line({ fr: 'Salade', course: 1 }), line({ fr: 'Brochettes', course: 2 }), line({ fr: 'Eau' })]
    const rows = paperLines(escpos(kitchenDoc(order, lines, OPTS)))
    const order_ = ['1 x Eau', '-- Service 1 --', '1 x Salade', '-- Service 2 --', '1 x Brochettes'].map((needle) =>
      rows.findIndex((r) => r.includes(needle))
    )
    expect(order_.every((i) => i >= 0)).toBe(true)
    expect([...order_].sort((a, b) => a - b)).toEqual(order_)
  })

  it('prints no course heading for a ticket of a single course 0', () => {
    expect(paperText(escpos(kitchenDoc(order, [line({ fr: 'Eau' })], OPTS)))).not.toContain('Service')
  })

  it('shows the order number for a counter order, with its type instead of a table', () => {
    const counter: KitchenOrderInfo = { ...order, type: 'takeaway', tableLabel: null, covers: 0, orderNumber: 12 }
    const text = paperText(escpos(kitchenDoc(counter, [line({ fr: 'Café' })], OPTS)))
    expect(text).toContain('N° 12')
    expect(text).toContain('À emporter')
    expect(text).not.toContain('Table')
    expect(text).not.toContain('Couverts')
  })

  it('shows a weight as decimals', () => {
    expect(paperText(escpos(kitchenDoc(order, [line({ fr: 'Pain', qtyMilli: 350 })], OPTS)))).toContain('0,350 x Pain')
  })

  it('prints in the language of the printer, as a raster for Arabic', () => {
    const doc = kitchenDoc(order, [line({ fr: 'Tajine', ar: 'طاجين' })], { lang: 'ar', widthMm: 58 })
    expect(doc).toMatchObject({ raster: true, widthMm: 58 })
    const html = 'html' in doc ? doc.html : ''
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('طاجين')
    expect(html).toContain('الطاولة')
  })

  it('wraps long names inside the paper', () => {
    const rows = paperLines(escpos(kitchenDoc(order, [line({ fr: 'Tajine de poulet aux citrons confits et olives violettes', note: 'a'.repeat(80) })], { ...OPTS, widthMm: 58 })))
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(32)
  })
})
