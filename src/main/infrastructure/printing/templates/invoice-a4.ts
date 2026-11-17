import type { TicketSnapshot } from '@shared/dto'
import { pickName, type Lang } from '@shared/names'
import { escapeHtml, FONT_STACK } from './layout'
import { formatAmount, formatDate, formatQty, formatRate, labelsFor } from './labels'

/**
 * What an invoice prints: its own number and date, the customer it is made out to (a company with its ICE),
 * and the ticket it is made from, frozen. Task 14's `InvoiceDto` carries these.
 */
export interface InvoiceDoc {
  numberLabel: string
  createdAt: string
  customer: { name: string; companyName?: string; address?: string; ice?: string; phone?: string }
  snapshot: TicketSnapshot
}

/**
 * The A4 invoice as a complete HTML page (printed through the system driver or saved as PDF). Amounts are TTC
 * as the store enters them; the HT and the VAT per rate come from the ticket's VAT breakdown.
 */
export function invoiceA4Html(invoice: InvoiceDoc, lang: Lang): { html: string } {
  const L = labelsFor(lang)
  const { snapshot: s, customer } = invoice
  const b = s.business
  const e = escapeHtml
  // Data is isolated (`<bdi>`) so a French name or a number keeps its order inside an Arabic page.
  const bdi = (text: string): string => `<bdi>${e(text)}</bdi>`
  const amt = (cents: number): string => `<bdi>${formatAmount(cents)}</bdi>`
  const line = (label: string, value: string): string => (value ? `<div>${e(label)} : ${bdi(value)}</div>` : '')
  // The legal identity at the foot: only what the business has (a café run under a patente has no ICE, IF or RC).
  const ids = ([[L.ice, b.ice], [L.if, b.if], [L.rc, b.rc], [L.patente, b.patente]] as const).filter(([, value]) => value)
  const legalLines = [
    ...(b.raisonSociale ? [`<div>${bdi(b.raisonSociale)}</div>`] : []),
    ...(ids.length ? [`<div>${ids.map(([label, value]) => `${e(label)} : ${e(value)}`).join(' · ')}</div>`] : [])
  ]
  const legalFooter = legalLines.length ? `<div class="legal">\n${legalLines.join('\n')}\n</div>` : ''

  // The total of a line is its net of its own discount, as on the receipt: the column adds up to the subtotal,
  // and with the ticket discount to the total TTC.
  const rows = s.lines
    .map((l) => {
      const unit = l.unitPriceCents + l.modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0)
      const modifiers = l.modifiers.map((m) => `<div class="sub">${bdi(`+ ${pickName(m.name, lang)}`)}</div>`).join('')
      const label = l.free ? L.free : l.discount?.kind === 'pct' ? `${L.discount} ${formatRate(l.discount.bp)}` : L.discount
      const discount =
        l.lineDiscountCents === 0
          ? ''
          : `<tr class="sub"><td colspan="4">${e(label)} (${amt(-l.lineDiscountCents)})</td></tr>`
      return `<tr><td>${bdi(pickName(l.name, lang))}${modifiers}</td><td class="n">${bdi(formatQty(l.qtyMilli))}</td><td class="n">${amt(unit)}</td><td class="n">${amt(l.grossCents - l.lineDiscountCents)}</td></tr>${discount}`
    })
    .join('\n')

  const vatRows = s.vat
    .map(
      (v) =>
        `<tr><td>${bdi(formatRate(v.rateBp))}</td><td class="n">${amt(v.ht)}</td><td class="n">${amt(v.vat)}</td></tr>`
    )
    .join('\n')
  const ht = s.vat.reduce((sum, v) => sum + v.ht, 0)
  const vat = s.vat.reduce((sum, v) => sum + v.vat, 0)
  const ticketDiscount =
    s.totals.ticketDiscountCents === 0
      ? ''
      : `<tr><td>${e(L.subtotal)}</td><td class="n">${amt(s.totals.grossCents - s.totals.lineDiscountsCents)}</td></tr>
<tr><td>${e(L.ticketDiscount)}</td><td class="n">${amt(-s.totals.ticketDiscountCents)}</td></tr>`

  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${e(L.invoiceNo)} ${e(invoice.numberLabel)}</title>
<style>
@page{size:A4;margin:15mm}
html,body{margin:0;padding:0;background:#fff;color:#111}
body{font-family:${FONT_STACK};font-size:10.5pt;line-height:1.4}
header{display:flex;justify-content:space-between;gap:12mm;margin-bottom:10mm}
h1{margin:0 0 2mm;font-size:22pt;letter-spacing:.04em}
.issuer .name{font-size:14pt;font-weight:700}
.meta{text-align:end}
.billed{border:1px solid #999;border-radius:2mm;padding:4mm;margin-bottom:8mm;max-width:90mm}
.billed .title{font-weight:700;margin-bottom:1mm}
table{width:100%;border-collapse:collapse}
th{background:#eee;text-align:start;padding:2mm;border-bottom:1px solid #333}
td{padding:2mm;border-bottom:1px solid #ddd;vertical-align:top}
.n{text-align:end;white-space:nowrap}
th.n{text-align:end}
.sub{color:#555;font-size:9.5pt}
.summary{display:flex;justify-content:space-between;align-items:flex-start;gap:10mm;margin-top:8mm}
.vat{width:90mm}
.totals{width:80mm}
.totals td{border:0;padding:1mm 2mm}
.totals .grand td{font-weight:700;font-size:12pt;border-top:2px solid #111;padding-top:2mm}
.legal{margin-top:12mm;font-size:9pt;color:#444;border-top:1px solid #ccc;padding-top:3mm}
</style>
</head>
<body>
<header>
<div class="issuer">
<div class="name">${bdi(b.nomCommercial)}</div>
${[b.raisonSociale, b.adresse, b.ville].filter(Boolean).map((text) => `<div>${bdi(text)}</div>`).join('\n')}
${line(L.tel, b.telephone)}
</div>
<div class="meta">
<h1>${e(L.invoice)}</h1>
<div><strong>${e(L.invoiceNo)} ${bdi(invoice.numberLabel)}</strong></div>
<div>${e(L.invoiceDate)} : ${bdi(formatDate(invoice.createdAt))}</div>
<div>${e(L.forTicket)} ${bdi(s.label)}</div>
</div>
</header>
<section class="billed">
<div class="title">${e(L.billedTo)}</div>
<div>${bdi(customer.companyName || customer.name)}</div>
${customer.companyName && customer.name && customer.name !== customer.companyName ? `<div>${bdi(customer.name)}</div>` : ''}
${customer.address ? `<div>${bdi(customer.address)}</div>` : ''}
${line(L.tel, customer.phone ?? '')}
${line(L.ice, customer.ice ?? '')}
</section>
<table>
<thead><tr><th>${e(L.designation)}</th><th class="n">${e(L.qty)}</th><th class="n">${e(L.unitPrice)}</th><th class="n">${e(L.lineTotal)}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="summary">
<table class="vat">
<thead><tr><th>${e(L.vatRate)}</th><th class="n">${e(L.totalHt)}</th><th class="n">${e(L.totalVat)}</th></tr></thead>
<tbody>
${vatRows}
</tbody>
</table>
<table class="totals">
${ticketDiscount}
<tr><td>${e(L.totalHt)}</td><td class="n">${amt(ht)}</td></tr>
<tr><td>${e(L.totalVat)}</td><td class="n">${amt(vat)}</td></tr>
<tr class="grand"><td>${e(L.totalTtc)}</td><td class="n">${amt(s.totals.totalCents)}</td></tr>
</table>
</div>
${legalFooter}
</body>
</html>
`
  return { html }
}
