import { describe, expect, it } from 'vitest'
import { receiptDoc } from '../../../src/main/infrastructure/printing/templates/receipt'
import { formatMoney } from '../../../src/shared/money'
import { decodeRasterCommands } from '../../../src/main/infrastructure/printing/raster'
import { paperLines, paperText } from '../../helpers/escpos-decode'
import { sampleCredit, sampleSale } from '../../helpers/printing'

const escpos = (doc: ReturnType<typeof receiptDoc>): Buffer => {
  if (!('escpos' in doc)) throw new Error('expected an ESC/POS document')
  return doc.escpos
}
const htmlOf = (doc: ReturnType<typeof receiptDoc>): string => {
  if (!('html' in doc)) throw new Error('expected an HTML document')
  return doc.html
}

const OPTS = { lang: 'fr', widthMm: 80, duplicate: false, raster: false } as const

/** Two Tajines (7 000 + a 2,00 cooking supplement), a Thé with 10 % off, a free coffee, paid in cash. */
const rich = () =>
  sampleSale(
    [
      { name: { fr: 'Tajine poulet citron', ar: 'طاجين', en: 'Chicken tagine' }, qtyMilli: 2000, unitPriceCents: 7000, vatBp: 1000, modifiers: [{ name: 'Bien cuit', deltaCents: 200 }], note: 'sans oignon' },
      { name: { fr: 'Thé à la menthe' }, qtyMilli: 3000, unitPriceCents: 1200, vatBp: 2000, discount: { kind: 'pct', bp: 1000, reason: 'fidélité' } },
      { name: { fr: 'Café' }, unitPriceCents: 1000, vatBp: 2000, free: true }
    ],
    {
      orderNumber: 12,
      header: 'Bienvenue',
      payments: [
        { methodCode: 'card', amountCents: 10000, tenderedCents: 10000 },
        { methodCode: 'cash', amountCents: 7640, tenderedCents: 10000 }
      ]
    }
  )

describe('receiptDoc (text mode, 80 mm)', () => {
  it('prints the legal identity, the ticket, the lines, the total, the VAT, the payments and the footer', () => {
    const text = paperText(escpos(receiptDoc(rich(), OPTS)))
    for (const expected of [
      'Restaurant Dar Atlas',
      '12 rue Tarik',
      'Marrakech',
      'Tél : 0524000000',
      'ICE : 001234567000089',
      'IF : 12345678',
      'RC : 98765',
      'Patente : 45678901',
      'Bienvenue',
      'Ticket N° 000123',
      '22/10/2026 11:15',
      'Table : T4',
      'Couverts : 3',
      'Commande N° 12',
      'Serveur : Amine',
      'Merci de votre visite !'
    ]) {
      expect(text).toContain(expected)
    }
    expect(text).toContain('Tajine poulet citron')
    expect(text).toContain('TOTAL TTC')
  })

  it('shows quantity times name with the gross amount, modifiers and notes indented under it', () => {
    const rows = paperLines(escpos(receiptDoc(rich(), OPTS)))
    const at = rows.findIndex((r) => r.startsWith('2 x Tajine poulet citron'))
    expect(at).toBeGreaterThan(-1)
    expect(rows[at]!.endsWith('144,00')).toBe(true)
    expect(rows[at + 1]).toMatch(/^ {2}\+ Bien cuit\s+2,00$/)
    expect(rows[at + 2]).toMatch(/^ {2}> sans oignon$/)
  })

  it('shows a line discount and an offered line as negative rows under their line', () => {
    const rows = paperLines(escpos(receiptDoc(rich(), OPTS)))
    const tea = rows.findIndex((r) => r.startsWith('3 x Thé à la menthe'))
    expect(rows[tea]!.endsWith('36,00')).toBe(true)
    expect(rows[tea + 1]).toMatch(/^ {2}Remise 10 %\s+-3,60$/)
    const coffee = rows.findIndex((r) => r.startsWith('1 x Café'))
    expect(rows[coffee + 1]).toMatch(/^ {2}Offert\s+-10,00$/)
  })

  it('adds the subtotal and the ticket discount before the total when the ticket is discounted', () => {
    const snapshot = sampleSale([{ unitPriceCents: 10000 }], {
      discount: { kind: 'pct', bp: 1000, reason: 'x' },
      payments: [{ methodCode: 'cash', amountCents: 9000, tenderedCents: 9000 }]
    })
    const rows = paperLines(escpos(receiptDoc(snapshot, OPTS)))
    expect(rows.some((r) => /^Sous-total\s+100,00$/.test(r))).toBe(true)
    expect(rows.some((r) => /^Remise ticket 10 %\s+-10,00$/.test(r))).toBe(true)
    expect(rows.some((r) => r.startsWith('TOTAL TTC') && r.endsWith('90,00 DH'))).toBe(true)
  })

  it('prints the total with the currency and one VAT row per rate, exactly TVA 10 % : HT 246,36 TVA 24,64', () => {
    const snapshot = sampleSale([{ unitPriceCents: 27100, vatBp: 1000 }])
    const rows = paperLines(escpos(receiptDoc(snapshot, OPTS)))
    expect(rows).toContain('TVA 10 % : HT 246,36 TVA 24,64')
    expect(rows.some((r) => /^TOTAL TTC\s+271,00 DH$/.test(r))).toBe(true)
    expect(rows.filter((r) => r.startsWith('TVA ')).every((r) => !r.includes('DH'))).toBe(true)
  })

  it('falls back to two rows when a VAT row does not fit the paper', () => {
    const snapshot = sampleSale([{ unitPriceCents: 148150, vatBp: 2000 }])
    const rows = paperLines(escpos(receiptDoc(snapshot, { ...OPTS, widthMm: 58 })))
    const at = rows.findIndex((r) => r.startsWith('TVA 20 %'))
    expect(rows[at]).toHaveLength(32)
    expect(rows[at]).toMatch(/^TVA 20 %\s+HT 1.234,58$/)
    expect(rows[at + 1]).toHaveLength(32)
    expect(rows[at + 1]).toMatch(/^\s+TVA 246,92$/)
  })

  it('prints each payment as tendered, then the change', () => {
    const rows = paperLines(escpos(receiptDoc(rich(), OPTS)))
    expect(rows.some((r) => /^Carte bancaire\s+100,00$/.test(r))).toBe(true)
    expect(rows.some((r) => /^Espèces\s+100,00$/.test(r))).toBe(true)
    expect(rows.some((r) => /^Rendu\s+23,60$/.test(r))).toBe(true)
  })

  it('marks a reprint DUPLICATA', () => {
    expect(paperText(escpos(receiptDoc(rich(), { ...OPTS, duplicate: true })))).toContain('DUPLICATA')
    expect(paperText(escpos(receiptDoc(rich(), OPTS)))).not.toContain('DUPLICATA')
  })

  it('prints a credit note with its own label, the sale it cancels and negative amounts', () => {
    const credit = sampleCredit(sampleSale([{ unitPriceCents: 5000 }]))
    const text = paperText(escpos(receiptDoc(credit, OPTS)))
    expect(text).toContain('Avoir N° AV-000007')
    expect(text).toContain('Réf. ticket 000123')
    expect(text).toContain('Motif : Erreur de caisse')
    expect(text).toContain('-50,00 DH')
    expect(text).toContain('Remboursement')
  })

  it('stays within the paper: no row wider than 48 columns at 80 mm, 32 at 58 mm', () => {
    const snapshot = sampleSale(
      [
        { name: { fr: 'Tajine de poulet aux citrons confits et olives violettes de Meknès' }, qtyMilli: 2000, unitPriceCents: 123456, modifiers: [{ name: 'Supplément de légumes grillés', deltaCents: 1500 }], note: 'sans oignon, sauce a part et bien chaud' },
        { unitPriceCents: 1 }
      ],
      { header: 'Une ligne de bienvenue qui est beaucoup trop longue pour tenir sur une seule ligne' }
    )
    for (const [widthMm, columns] of [[80, 48], [58, 32]] as const) {
      const rows = paperLines(escpos(receiptDoc(snapshot, { ...OPTS, widthMm })))
      expect(Math.max(...rows.map((r) => r.length)), `${widthMm} mm`).toBeLessThanOrEqual(columns)
    }
  })

  it('uses the total of the money formatting rules (thin spaces folded to blanks)', () => {
    const snapshot = sampleSale([{ unitPriceCents: 245000 }])
    const rows = paperLines(escpos(receiptDoc(snapshot, OPTS)))
    expect(rows.some((r) => r.endsWith('2 450,00 DH'))).toBe(true)
    expect(formatMoney(245000, 'fr')).toContain(String.fromCodePoint(0x202f))
  })

  it('ends with a cut and starts with init + code page 19', () => {
    const buf = escpos(receiptDoc(rich(), OPTS))
    expect(buf.subarray(0, 5).toString('hex')).toBe('1b401b7413')
    expect(buf.subarray(-4).toString('hex')).toBe('1d564200')
  })

  it('prints no logo in text mode', () => {
    const buf = escpos(receiptDoc(rich(), { ...OPTS, logo: 'data:image/png;base64,AAAA' }))
    expect(decodeRasterCommands(buf)).toBeUndefined()
  })
})

describe('receiptDoc (raster)', () => {
  it('is HTML to rasterise when the printer prints images', () => {
    const doc = receiptDoc(rich(), { ...OPTS, raster: true })
    expect(doc).toMatchObject({ raster: true, widthMm: 80 })
    const html = htmlOf(doc)
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('Tajine poulet citron')
    expect(html).toContain('TOTAL TTC')
  })

  it('is raster for Arabic even when the printer does not ask for it', () => {
    const doc = receiptDoc(sampleSale([{ name: { fr: 'Tajine', ar: 'طاجين' }, unitPriceCents: 7000 }], { lang: 'ar' }), {
      lang: 'ar',
      widthMm: 80,
      duplicate: false,
      raster: false
    })
    expect(doc).toMatchObject({ raster: true })
    const html = htmlOf(doc)
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('طاجين')
    expect(html).toContain('المجموع شامل الضريبة')
    expect(html).toContain('70,00')
    expect(html).toContain('درهم')
  })

  it('puts the logo first, and escapes what it prints', () => {
    const snapshot = sampleSale([{ name: { fr: '<b>Pizza</b> & "Cie"' }, unitPriceCents: 5000 }])
    const html = htmlOf(receiptDoc(snapshot, { ...OPTS, raster: true, logo: 'data:image/png;base64,AAAA' }))
    expect(html).toContain('<img class="logo" src="data:image/png;base64,AAAA"')
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('Restaurant Dar Atlas'))
    expect(html).toContain('&lt;b&gt;Pizza&lt;/b&gt; &amp; &quot;Cie&quot;')
    expect(html).not.toContain('<b>Pizza')
  })

  it('is measured in millimetres when it goes to a system printer', () => {
    const doc = receiptDoc(rich(), { ...OPTS, paper: true })
    expect(doc).toMatchObject({ raster: false, widthMm: 80 })
    expect(htmlOf(doc)).toMatch(/width:\s*72mm/)
  })
})
