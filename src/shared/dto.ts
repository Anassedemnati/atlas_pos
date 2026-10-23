import type { Lang, LocalizedName } from './names'
import type { VatRow } from './vat'

// Data transfer objects: what crosses the IPC / HTTP boundary to the renderer and the back office.
// Plain data only (no classes, no Dates); `null` is "absent", as in the database.

export interface CategoryDto {
  id: string
  name: LocalizedName
  /** `#RRGGBB`. */
  color: string
  sort: number
  active: boolean
  /** Relative to the media folder. */
  imagePath: string | null
}

export interface ProductDto {
  id: string
  categoryId: string
  name: LocalizedName
  /** TTC, integer centimes (per kilogram when `soldByWeight`). */
  priceCents: number
  /** Basis points: 2000 = 20 %. */
  vatBp: number
  barcode: string | null
  soldByWeight: boolean
  color: string | null
  imagePath: string | null
  keySize: number
  sort: number
  active: boolean
  stockTracked: boolean
  /** Milli-units: 1 item = 1000. Negative when oversold. */
  stockMilli: number
  lowStockMilli: number
  /** 0 = no course, then 1, 2, 3... */
  course: number
  /** In the order of the groups. */
  modifierGroupIds: string[]
}

export interface ModifierGroupDto {
  id: string
  name: LocalizedName
  minSelect: number
  maxSelect: number
  modifiers: { id: string; name: LocalizedName; priceDeltaCents: number }[]
}

export interface MenuDto {
  id: string
  /** The product that carries the menu's price. */
  productId: string
  courses: {
    id: string
    name: LocalizedName
    chooseCount: number
    items: { productId: string; supplementCents: number }[]
  }[]
}

export interface CatalogDto {
  categories: CategoryDto[]
  products: ProductDto[]
  modifierGroups: ModifierGroupDto[]
  menus: MenuDto[]
}

/** One product line of an Excel / CSV catalogue sheet, parsed and validated. */
export interface ImportRow {
  /** 1-based row of the sheet (the header is row 1), so an error can point at the line. */
  row: number
  /** French name of the category (`categorie`). */
  category: string
  nameFr: string
  nameAr?: string
  nameEn?: string
  priceCents: number
  vatBp: number
  barcode?: string
  soldByWeight: boolean
  /**
   * Present means the stock is tracked, starting at this quantity (milli-units): it sets the stock of a
   * new product, or of one that starts being tracked; a product already tracked keeps its live quantity.
   */
  stockMilli?: number
  color?: string
}

/** A problem found in a sheet. `row` is 0 and `field` is `file` when the whole file is refused. */
export interface ImportError {
  row: number
  /** The column header (`tva`, `prix`...). */
  field: string
  /** i18n key, `errors.import_*`. */
  messageKey: string
}

export interface ParsedCatalogSheet {
  /** The rows without any error. */
  rows: ImportRow[]
  errors: ImportError[]
}

export type ImportMode = 'merge' | 'replace'

export interface ImportSummary {
  mode: ImportMode
  categoriesCreated: number
  created: number
  updated: number
  /** Products of a `replace` import that are gone. */
  deleted: number
  /** Products of a `replace` import that were sold, or are in a menu, and are now inactive. */
  deactivated: number
}

// Orders, tickets, business days, customers ----------------------------------------------------

/** A percentage in basis points (1000 = 10 %) or a fixed amount in centimes, with its reason. */
export type DiscountDto = { kind: 'pct'; bp: number; reason: string } | { kind: 'amount'; cents: number; reason: string }

export interface LineModifierDto {
  /** The modifier; for a set-menu choice, the chosen product. */
  id: string
  name: LocalizedName
  /** Added to the unit price (a set-menu supplement); may be negative. */
  priceDeltaCents: number
  /** Set on a set-menu choice: the course it was chosen in. */
  menuCourseId?: string
}

export type OrderType = 'dine_in' | 'takeaway' | 'delivery' | 'counter'
export type OrderStatus = 'open' | 'parked' | 'closed' | 'cancelled'

export interface OrderLineDto {
  id: string
  seq: number
  productId: string
  name: LocalizedName
  qtyMilli: number
  unitPriceCents: number
  vatBp: number
  modifiers: LineModifierDto[]
  note: string
  course: number
  status: 'active' | 'void'
  voidReason: string
  /** ISO instant the line went to the kitchen. */
  sentAt: string | null
  discount: DiscountDto | null
  free: boolean
  freeReason: string
  userId: string
  createdAt: string
  /** What the line comes to on the ticket, its share of the ticket discount taken off; 0 when void. */
  netCents: number
}

export interface PaymentDto {
  id: string
  methodCode: string
  /** The part applied to the bill. */
  amountCents: number
  /** What the customer handed over (above the amount for cash: the change). */
  tenderedCents: number
  createdAt: string
  userId: string
}

export interface OrderTotalsDto {
  grossCents: number
  /** Line discounts and free lines. */
  lineDiscountsCents: number
  ticketDiscountCents: number
  totalCents: number
  vat: VatRow[]
}

export interface OrderDto {
  id: string
  dayId: string
  type: OrderType
  tableId: string | null
  tableLabel: string | null
  covers: number
  /** Café / snack counter number, 1-999. */
  orderNumber: number | null
  status: OrderStatus
  userId: string
  customerId: string | null
  openedAt: string
  updatedAt: string
  note: string
  discount: DiscountDto | null
  /** Every line, void ones included, by `seq`. */
  lines: OrderLineDto[]
  payments: PaymentDto[]
  totals: OrderTotalsDto
  paidCents: number
  dueCents: number
  changeCents: number
}

/** The identity printed on every ticket (setting `business.legal`). */
export interface BusinessLegalDto {
  raisonSociale: string
  nomCommercial: string
  adresse: string
  ville: string
  telephone: string
  ice: string
  if: string
  rc: string
  patente: string
}

export interface CustomerDto {
  id: string
  name: string
  phone: string
  address: string
  companyName: string
  /** 15 digits for a company. */
  ice: string
  isCompany: boolean
  notes: string
  createdAt: string
}

export interface TicketLineSnapshot {
  id: string
  productId: string
  /** The product's category when the ticket was closed (null if the product was gone). */
  categoryId: string | null
  categoryName: LocalizedName | null
  name: LocalizedName
  qtyMilli: number
  unitPriceCents: number
  modifiers: LineModifierDto[]
  note: string
  vatBp: number
  discount: DiscountDto | null
  free: boolean
  freeReason: string
  grossCents: number
  /** The line discount, or the whole gross of a free line. */
  lineDiscountCents: number
  ticketDiscountCents: number
  netCents: number
}

/**
 * Everything a ticket prints, frozen when it is closed (`tickets.snapshot_json`): a reprint and the Z
 * report read this, never the live rows. A credit note carries the original's figures negated.
 */
export interface TicketSnapshot {
  version: 1
  kind: 'sale' | 'credit'
  number: number
  /** `000123`, or `AV-000007` for a credit note. */
  label: string
  closedAt: string
  dayNumber: number
  business: BusinessLegalDto
  receipt: { lang: Lang; header: string; footer: string }
  order: {
    id: string
    type: OrderType
    number: number | null
    table: { id: string; label: string } | null
    covers: number
    note: string
  }
  customer: Omit<CustomerDto, 'createdAt' | 'notes'> | null
  user: { id: string; displayName: string }
  lines: TicketLineSnapshot[]
  ticketDiscount: DiscountDto | null
  totals: Omit<OrderTotalsDto, 'vat'>
  vat: VatRow[]
  payments: { methodCode: string; methodName: LocalizedName; amountCents: number; tenderedCents: number }[]
  paidCents: number
  changeCents: number
  /** On a credit note: the ticket it cancels, and why. */
  ref?: { ticketId: string; label: string; reason: string }
}

export interface TicketDto {
  id: string
  kind: 'sale' | 'credit'
  number: number
  label: string
  orderId: string
  dayId: string
  refTicketId: string | null
  closedAt: string
  userId: string
  totalCents: number
  reprintCount: number
  snapshot: TicketSnapshot
}

/** A business day: from the first sale after a Z closure to the next Z. */
export interface DayDto {
  id: string
  number: number
  openedAt: string
  closedAt: string | null
}

export interface DayGateDto {
  /** `must_close`: the till asks for the Z of the previous day before any new sale. */
  state: 'ok' | 'must_close'
  /** The open day; with no day open, the number the next one will get and `openedAt` null. */
  dayNumber: number
  openedAt: string | null
}

/**
 * An X report (the day so far: `zNumber` and `closedAt` null) or a Z report. Credit notes count in
 * negative, so a cancelled sale nets to zero. `grossCents - discountsCents - freeItems.cents === totalCents`.
 */
export interface ZData {
  dayNumber: number
  zNumber: number | null
  openedAt: string
  closedAt: string | null
  ticketsCount: number
  creditsCount: number
  grossCents: number
  /** Line and ticket discounts; free items are not in it (see `freeItems`). */
  discountsCents: number
  totalCents: number
  byPayment: { methodCode: string; name: LocalizedName; count: number; cents: number }[]
  byVat: VatRow[]
  byCategory: { categoryId: string | null; name: LocalizedName | null; qtyMilli: number; cents: number }[]
  byUser: { userId: string; displayName: string; ticketsCount: number; cents: number }[]
  /** Lines removed from orders of the day, at their gross. */
  voids: { count: number; cents: number }
  freeItems: { count: number; cents: number }
  /** Duplicates printed during the day. */
  reprints: number
}
