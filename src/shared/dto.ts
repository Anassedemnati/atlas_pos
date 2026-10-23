import type { LocalizedName } from './names'

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
