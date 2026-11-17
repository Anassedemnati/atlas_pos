import { describe, expect, it } from 'vitest'
import type { ZData } from '../../../src/shared/dto'
import { invoiceA4Html, type InvoiceDoc } from '../../../src/main/infrastructure/printing/templates/invoice-a4'
import { testPageDoc } from '../../../src/main/infrastructure/printing/templates/test-page'
import { zReportDoc } from '../../../src/main/infrastructure/printing/templates/z-report'
import { LABELS } from '../../../src/main/infrastructure/printing/templates/labels'
import { paperLines, paperText } from '../../helpers/escpos-decode'
import { BUSINESS, printer, sampleSale } from '../../helpers/printing'

const z: ZData = {
  dayNumber: 7,
  zNumber: 12,
  openedAt: new Date(2026, 9, 22, 8, 0).toISOString(),
  closedAt: new Date(2026, 9, 22, 23, 0).toISOString(),
  ticketsCount: 41,
  creditsCount: 1,
  grossCents: 1234500,
  discountsCents: 20000,
  totalCents: 1204500,
  byPayment: [
    { methodCode: 'cash', name: { fr: 'Espèces', ar: 'نقداً' }, count: 30, cents: 804500 },
    { methodCode: 'card', name: { fr: 'Carte bancaire' }, count: 11, cents: 400000 }
  ],
  byVat: [
    { rateBp: 2000, ttc: 400000, ht: 333333, vat: 66667 },
    { rateBp: 1000, ttc: 804500, ht: 731364, vat: 73136 }
  ],
  byCategory: [
    { categoryId: 'c1', name: { fr: 'Plats' }, qtyMilli: 55000, cents: 900000 },
    { categoryId: null, name: null, qtyMilli: 1500, cents: 4500 }
  ],
  byUser: [{ userId: 'u1', displayName: 'Amine', ticketsCount: 41, cents: 1204500 }],
  voids: { count: 2, cents: 5000 },
  freeItems: { count: 1, cents: 10000 },
  reprints: 3
}

describe('zReportDoc', () => {
  const text = (data: ZData = z): string => {
    const doc = zReportDoc(data, 'fr', { widthMm: 80, business: BUSINESS })
    if (!('escpos' in doc)) throw new Error('expected ESC/POS')
    return paperText(doc.escpos)
  }

  it('prints the Z number, the day, the counts and the totals', () => {
    const t = text()
    expect(t).toContain('Restaurant Dar Atlas')
    expect(t).toContain('RAPPORT Z N° 12')
    expect(t).toContain('Journée 7')
    expect(t).toMatch(/Tickets\s+41/)
    expect(t).toMatch(/Avoirs\s+1/)
    expect(t).toMatch(/Brut\s+12.345,00 DH/)
    expect(t).toMatch(/Remises\s+-200,00 DH/)
    expect(t).toMatch(/Offerts\s+-100,00 DH/)
    expect(t).toMatch(/Total\s+12.045,00 DH/)
  })

  it('prints the payments, the VAT per rate, the categories and the sellers', () => {
    const rows = paperLines(
      (zReportDoc(z, 'fr', { widthMm: 80, business: BUSINESS }) as { escpos: Buffer }).escpos
    )
    expect(rows.some((r) => /^Espèces \(30\)\s+8.045,00$/.test(r))).toBe(true)
    expect(rows.some((r) => /^Carte bancaire \(11\)\s+4.000,00$/.test(r))).toBe(true)
    expect(rows).toContain('TVA 20 % : HT 3 333,33 TVA 666,67')
    expect(rows.some((r) => /^Plats \(55\)\s+9.000,00$/.test(r))).toBe(true)
    expect(rows.some((r) => /^Amine \(41\)\s+12.045,00$/.test(r))).toBe(true)
  })

  it('prints voids, offered items and duplicates', () => {
    const t = text()
    expect(t).toMatch(/Lignes annulées \(2\)\s+50,00 DH/)
    expect(t).toMatch(/Duplicatas\s+3/)
  })

  it('is an X report while the day is open', () => {
    const t = text({ ...z, zNumber: null, closedAt: null })
    expect(t).toContain('RAPPORT X')
    expect(t).not.toContain('RAPPORT Z')
    expect(t).not.toContain('Clôture')
  })

  it('goes through the image path in Arabic', () => {
    const doc = zReportDoc(z, 'ar', { widthMm: 80, business: BUSINESS })
    expect(doc).toMatchObject({ raster: true })
    expect('html' in doc && doc.html).toContain('تقرير Z رقم')
  })
})

describe('testPageDoc', () => {
  const doc = (over = {}, lang?: 'fr' | 'ar') =>
    testPageDoc(printer({ name: 'Cuisine', kind: 'network', address: '192.168.1.50:9100', widthMm: 58, lang: lang ?? 'fr', ...over }), {
      businessName: 'Restaurant Dar Atlas',
      now: new Date(2026, 9, 22, 12, 30).toISOString()
    })

  it('names the business and the printer, and prints a ruler as wide as the paper and the confirmation', () => {
    const d = doc()
    if (!('escpos' in d)) throw new Error('expected ESC/POS')
    const rows = paperLines(d.escpos)
    expect(rows).toContain('Restaurant Dar Atlas')
    expect(rows).toContain('Imprimante : Cuisine')
    expect(rows).toContain('Type : network')
    expect(rows).toContain('Adresse : 192.168.1.50:9100')
    expect(rows).toContain('Largeur : 58 mm')
    expect(rows).toContain('22/10/2026 12:30')
    expect(rows).toContain('12345678901234567890123456789012')
    expect(rows).toContain("Test d'impression OK")
  })

  it('rules the full width of an 80 mm paper', () => {
    const d = doc({ widthMm: 80 })
    expect(paperLines((d as { escpos: Buffer }).escpos)).toContain('123456789012345678901234567890123456789012345678')
  })

  it('prints accents to check the code page', () => {
    const d = doc()
    expect(paperText((d as { escpos: Buffer }).escpos)).toContain('éèêëàâçùûôîï €')
  })

  it('leaves out the address of a printer without one', () => {
    const d = doc({ address: '' })
    expect(paperText((d as { escpos: Buffer }).escpos)).not.toContain('Adresse')
  })

  it('is raster for Arabic and for an image printer, millimetres for a system printer', () => {
    expect(doc({}, 'ar')).toMatchObject({ raster: true })
    expect(doc({ raster: true })).toMatchObject({ raster: true })
    expect(doc({ kind: 'os-html', widthMm: 80 })).toMatchObject({ raster: false })
  })
})

describe('invoiceA4Html', () => {
  const sale = sampleSale(
    [
      { name: { fr: 'Tajine', ar: 'طاجين' }, qtyMilli: 2000, unitPriceCents: 7000, vatBp: 1000, modifiers: [{ name: 'Bien cuit', deltaCents: 200 }] },
      { name: { fr: 'Thé' }, unitPriceCents: 1200, vatBp: 2000, discount: { kind: 'pct', bp: 1000, reason: 'x' } }
    ],
    { discount: { kind: 'amount', cents: 1000, reason: 'geste' }, payments: [{ methodCode: 'cash', amountCents: 14388, tenderedCents: 14388 }] }
  )
  const invoice: InvoiceDoc = {
    numberLabel: 'F-2026-00001',
    createdAt: new Date(2026, 9, 23, 9, 0).toISOString(),
    customer: { name: 'Karim Alaoui', companyName: 'Alaoui & Fils <SARL>', address: '5 avenue Hassan II, Casablanca', ice: '002233445000011', phone: '0522000000' },
    snapshot: sale
  }

  it('is a complete A4 page with the issuer, the number, the customer with ICE and the lines', () => {
    const { html: markup } = invoiceA4Html(invoice, 'fr')
    const html = markup.replace(/<\/?bdi>/g, '')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@page')
    expect(html).toMatch(/size:\s*A4/)
    for (const expected of ['Dar Atlas SARL', '12 rue Tarik', 'ICE : 001234567000089', 'FACTURE', 'F-2026-00001', '23/10/2026', 'ICE : 002233445000011', '5 avenue Hassan II, Casablanca', 'Tajine', 'Bien cuit', 'Total HT', 'Total TVA', 'Total TTC']) {
      expect(html).toContain(expected)
    }
    expect(html).toContain('dir="ltr"')
  })

  it('prints only the legal fields the business has: a café under a patente shows no empty ICE, IF or RC', () => {
    const blank = { raisonSociale: '', adresse: '', ville: '', telephone: '', ice: '', if: '', rc: '', patente: '' }
    const patenteOnly = invoiceA4Html({ ...invoice, snapshot: { ...sale, business: { ...sale.business, ...blank, patente: '31234567' } } }, 'fr').html.replace(/<\/?bdi>/g, '')
    expect(patenteOnly).toContain('Patente : 31234567')
    expect(patenteOnly).not.toMatch(/IF : (·|<)/)
    expect(patenteOnly).not.toContain('ICE : 001234567000089')
    const nameOnly = invoiceA4Html({ ...invoice, snapshot: { ...sale, business: { ...sale.business, ...blank } } }, 'fr').html
    expect(nameOnly).not.toContain('class="legal"')
    expect(nameOnly).not.toContain('<div><bdi></bdi></div>')
  })

  it('escapes the customer data', () => {
    const { html } = invoiceA4Html(invoice, 'fr')
    expect(html).toContain('<bdi>Alaoui &amp; Fils &lt;SARL&gt;</bdi>')
    expect(html).not.toContain('<SARL>')
  })

  it('gives each rate its HT and VAT and the total in HT, VAT and TTC', () => {
    const { html } = invoiceA4Html(invoice, 'fr')
    const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    for (const v of sale.vat) expect(text).toContain(`${v.rateBp / 100} %`)
    const ht = sale.vat.reduce((n, v) => n + v.ht, 0)
    const vat = sale.vat.reduce((n, v) => n + v.vat, 0)
    expect(ht + vat).toBe(sale.totals.totalCents)
    expect(text).toContain(`${String(Math.trunc(sale.totals.totalCents / 100))},${String(sale.totals.totalCents % 100).padStart(2, '0')}`)
  })

  it('foots: the line totals and the ticket discount add up to the total TTC, discounts written beside the line', () => {
    const cents = (text: string): number => Math.round(Number(text.replace(/\s/g, '').replace(',', '.')) * 100)
    const { html } = invoiceA4Html(invoice, 'fr')
    // the main rows have four cells; the last is the line total
    const lineTotals = [...html.matchAll(/<tr><td>.*?<\/td><td class="n">.*?<\/td><td class="n">.*?<\/td><td class="n"><bdi>([^<]+)<\/bdi><\/td><\/tr>/g)].map((m) => cents(m[1]!))
    expect(lineTotals).toHaveLength(sale.lines.length)
    const discount = /<td>Remise ticket<\/td><td class="n"><bdi>([^<]+)<\/bdi>/.exec(html)
    const sum = lineTotals.reduce((n, c) => n + c, 0) + cents(discount![1]!)
    expect(sum).toBe(sale.totals.totalCents)
    expect(html).toContain('Remise 10 % (<bdi>-1,20</bdi>)')
    expect(html).toMatch(/<td>Sous-total<\/td><td class="n"><bdi>[^<]+<\/bdi>/)
    // the modifier is a name, with no amount
    expect(html).toContain('<div class="sub"><bdi>+ Bien cuit</bdi></div>')
  })

  it('is right to left in Arabic', () => {
    const { html } = invoiceA4Html(invoice, 'ar')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('فاتورة')
    expect(html).toContain('طاجين')
  })
})

describe('labels', () => {
  it('has every label in every language, none empty', () => {
    const keys = Object.keys(LABELS.fr)
    for (const lang of ['ar', 'en'] as const) {
      expect(Object.keys(LABELS[lang]).sort()).toEqual([...keys].sort())
      for (const key of keys) expect((LABELS[lang] as Record<string, string>)[key], `${lang}.${key}`).toBeTruthy()
    }
  })
})
