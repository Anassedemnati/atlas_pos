import type { Lang } from '@shared/names'

/**
 * The words printed on receipts, kitchen tickets, reports and invoices. This is printed output, not
 * interface text, so it does not live in the i18n catalogues: it is fixed per language and travels
 * with the template. French is the reference copy.
 */
const fr = {
  // identity
  tel: 'Tél',
  ice: 'ICE',
  if: 'IF',
  rc: 'RC',
  patente: 'Patente',
  // ticket
  ticket: 'Ticket N°',
  credit: 'Avoir N°',
  prebill: 'ADDITION',
  ref: 'Réf. ticket',
  reason: 'Motif',
  orderNo: 'Commande N°',
  table: 'Table',
  covers: 'Couverts',
  waiter: 'Serveur',
  dineIn: 'Sur place',
  takeaway: 'À emporter',
  delivery: 'Livraison',
  counter: 'Comptoir',
  customer: 'Client',
  duplicate: 'DUPLICATA',
  cancelled: 'ANNULÉ',
  // amounts
  subtotal: 'Sous-total',
  discount: 'Remise',
  ticketDiscount: 'Remise ticket',
  free: 'Offert',
  total: 'TOTAL TTC',
  vat: 'TVA',
  ht: 'HT',
  change: 'Rendu',
  refund: 'Remboursement',
  thanks: 'Merci',
  // kitchen
  course: 'Service',
  note: 'Note',
  // reports
  zReport: 'RAPPORT Z N°',
  xReport: 'RAPPORT X',
  day: 'Journée',
  openedAt: 'Ouverture',
  closedAt: 'Clôture',
  tickets: 'Tickets',
  credits: 'Avoirs',
  gross: 'Brut',
  discounts: 'Remises',
  freeItems: 'Offerts',
  voids: 'Lignes annulées',
  reprints: 'Duplicatas',
  byPayment: 'Par moyen de paiement',
  byVat: 'TVA par taux',
  byCategory: 'Par catégorie',
  byUser: 'Par vendeur',
  totalNet: 'Total',
  otherCategory: 'Autres',
  // test page
  testTitle: "TEST D'IMPRESSION",
  testPrinter: 'Imprimante',
  testKind: 'Type',
  testAddress: 'Adresse',
  testWidth: 'Largeur',
  testOk: "Test d'impression OK",
  // invoice
  invoice: 'FACTURE',
  invoiceNo: 'Facture N°',
  invoiceDate: 'Date',
  billedTo: 'Facturé à',
  designation: 'Désignation',
  qty: 'Qté',
  unitPrice: 'P.U. TTC',
  lineTotal: 'Total TTC',
  vatRate: 'Taux TVA',
  totalHt: 'Total HT',
  totalVat: 'Total TVA',
  totalTtc: 'Total TTC',
  forTicket: 'Ticket'
}

export type Labels = typeof fr

const ar: Labels = {
  tel: 'الهاتف',
  ice: 'ICE',
  if: 'IF',
  rc: 'RC',
  patente: 'الرسم المهني',
  ticket: 'تذكرة رقم',
  credit: 'إشعار دائن رقم',
  prebill: 'الحساب',
  ref: 'مرجع التذكرة',
  reason: 'السبب',
  orderNo: 'الطلب رقم',
  table: 'الطاولة',
  covers: 'عدد الأشخاص',
  waiter: 'النادل',
  dineIn: 'في المكان',
  takeaway: 'للأخذ',
  delivery: 'توصيل',
  counter: 'الشباك',
  customer: 'الزبون',
  duplicate: 'نسخة مطابقة',
  cancelled: 'ملغى',
  subtotal: 'المجموع الفرعي',
  discount: 'تخفيض',
  ticketDiscount: 'تخفيض التذكرة',
  free: 'مجاني',
  total: 'المجموع شامل الضريبة',
  vat: 'الضريبة',
  ht: 'قبل الضريبة',
  change: 'الباقي',
  refund: 'استرجاع',
  thanks: 'شكراً',
  course: 'الوجبة',
  note: 'ملاحظة',
  zReport: 'تقرير Z رقم',
  xReport: 'تقرير X',
  day: 'اليوم',
  openedAt: 'الفتح',
  closedAt: 'الإغلاق',
  tickets: 'التذاكر',
  credits: 'إشعارات دائنة',
  gross: 'الإجمالي',
  discounts: 'التخفيضات',
  freeItems: 'المجانيات',
  voids: 'أسطر ملغاة',
  reprints: 'النسخ المطابقة',
  byPayment: 'حسب طريقة الأداء',
  byVat: 'الضريبة حسب النسبة',
  byCategory: 'حسب الصنف',
  byUser: 'حسب البائع',
  totalNet: 'المجموع',
  otherCategory: 'أخرى',
  testTitle: 'اختبار الطباعة',
  testPrinter: 'الطابعة',
  testKind: 'النوع',
  testAddress: 'العنوان',
  testWidth: 'العرض',
  testOk: 'اختبار الطباعة ناجح',
  invoice: 'فاتورة',
  invoiceNo: 'فاتورة رقم',
  invoiceDate: 'التاريخ',
  billedTo: 'الفاتورة موجهة إلى',
  designation: 'البيان',
  qty: 'الكمية',
  unitPrice: 'الثمن للوحدة',
  lineTotal: 'المجموع شامل الضريبة',
  vatRate: 'نسبة الضريبة',
  totalHt: 'المجموع قبل الضريبة',
  totalVat: 'مجموع الضريبة',
  totalTtc: 'المجموع شامل الضريبة',
  forTicket: 'التذكرة'
}

const en: Labels = {
  tel: 'Tel',
  ice: 'ICE',
  if: 'IF',
  rc: 'RC',
  patente: 'Patente',
  ticket: 'Receipt no.',
  credit: 'Credit note no.',
  prebill: 'BILL',
  ref: 'Receipt ref.',
  reason: 'Reason',
  orderNo: 'Order no.',
  table: 'Table',
  covers: 'Covers',
  waiter: 'Server',
  dineIn: 'Dine in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  counter: 'Counter',
  customer: 'Customer',
  duplicate: 'DUPLICATE',
  cancelled: 'CANCELLED',
  subtotal: 'Subtotal',
  discount: 'Discount',
  ticketDiscount: 'Ticket discount',
  free: 'Free',
  total: 'TOTAL incl. VAT',
  vat: 'VAT',
  ht: 'excl.',
  change: 'Change',
  refund: 'Refund',
  thanks: 'Thank you',
  course: 'Course',
  note: 'Note',
  zReport: 'Z REPORT NO.',
  xReport: 'X REPORT',
  day: 'Day',
  openedAt: 'Opened',
  closedAt: 'Closed',
  tickets: 'Receipts',
  credits: 'Credit notes',
  gross: 'Gross',
  discounts: 'Discounts',
  freeItems: 'Free items',
  voids: 'Voided lines',
  reprints: 'Duplicates',
  byPayment: 'By payment method',
  byVat: 'VAT by rate',
  byCategory: 'By category',
  byUser: 'By seller',
  totalNet: 'Total',
  otherCategory: 'Other',
  testTitle: 'PRINT TEST',
  testPrinter: 'Printer',
  testKind: 'Type',
  testAddress: 'Address',
  testWidth: 'Width',
  testOk: 'Print test OK',
  invoice: 'INVOICE',
  invoiceNo: 'Invoice no.',
  invoiceDate: 'Date',
  billedTo: 'Billed to',
  designation: 'Description',
  qty: 'Qty',
  unitPrice: 'Unit price incl. VAT',
  lineTotal: 'Total incl. VAT',
  vatRate: 'VAT rate',
  totalHt: 'Total excl. VAT',
  totalVat: 'Total VAT',
  totalTtc: 'Total incl. VAT',
  forTicket: 'Receipt'
}

export const LABELS: Record<Lang, Labels> = { fr, ar, en }

export const labelsFor = (lang: Lang): Labels => LABELS[lang]

/** `2026-10-22T10:15:00Z` -> `22/10/2026 11:15`, in the machine's local time (the shop's). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** `22/10/2026`, local time. */
export const formatDate = (iso: string): string => formatDateTime(iso).slice(0, 10)

/** `11:15`, local time. */
export const formatTime = (iso: string): string => formatDateTime(iso).slice(11)

/** A quantity in thousandths: `2` for 2000, `0,350` for 350. */
export function formatQty(qtyMilli: number): string {
  if (qtyMilli % 1000 === 0) return String(qtyMilli / 1000)
  const whole = Math.trunc(Math.abs(qtyMilli) / 1000)
  const frac = String(Math.abs(qtyMilli) % 1000).padStart(3, '0')
  return `${qtyMilli < 0 ? '-' : ''}${whole},${frac}`
}

/** `1000` bp -> `10 %`, `550` -> `5,5 %`. */
export function formatRate(rateBp: number): string {
  const pct = rateBp / 100
  return `${Number.isInteger(pct) ? pct : String(pct).replace('.', ',')} %`
}

/** `246,36` or `2 450,00` (narrow no-break space): an amount without its currency. */
export function formatAmount(cents: number): string {
  const rounded = Math.round(cents)
  const abs = Math.abs(rounded)
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, String.fromCodePoint(0x202f))
  return `${rounded < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')}`
}
