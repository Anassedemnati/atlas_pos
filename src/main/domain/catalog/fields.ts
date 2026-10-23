import { z } from 'zod'
import type { ProductDto } from '@shared/dto'
import { CatalogProductSchema, CategorySchema, LocalizedNameSchema, MenuSchema, ModifierGroupSchema } from '../config/template'

// The rules of every catalogue field are the ones the setup profile (`config/template.ts`) already
// enforces, taken from its schemas instead of copied: whatever the catalogue accepts, a profile
// export can write. A rule may only be stricter here, never looser.

const product = CatalogProductSchema.shape
const modifier = ModifierGroupSchema.shape.modifiers.element.shape
const course = MenuSchema.shape.courses.element.shape
const menuItem = course.items.element.shape

export const ColorRule = CategorySchema.shape.color
/** `[0-9A-Za-z-]{1,32}`: what a scanner sends. */
export const BarcodeRule = product.barcode.unwrap()
export const PriceCentsRule = product.price_cents
export const VatBpRule = product.vat_bp
export const KeySizeRule = product.key_size.unwrap()
export const CourseRule = product.course.unwrap()
export const StockMilliRule = product.stock_milli.unwrap()
export const LowStockMilliRule = product.low_stock_milli.unwrap()
export const MinSelectRule = ModifierGroupSchema.shape.min_select.unwrap()
export const MaxSelectRule = ModifierGroupSchema.shape.max_select.unwrap()
export const PriceDeltaRule = modifier.price_delta_cents.unwrap()
export const ChooseCountRule = course.choose_count.unwrap()
export const SupplementRule = menuItem.supplement_cents.unwrap()

export const IdRule = z.string().min(1)

/** A name as typed: a blank Arabic or English name is the same as none, French is required. */
export const NameRule = z
  .strictObject({ fr: z.string(), ar: z.string().optional(), en: z.string().optional() })
  .transform((name) => {
    const filled = (value: string | undefined): value is string => value !== undefined && value.trim() !== ''
    return { fr: name.fr, ...(filled(name.ar) ? { ar: name.ar } : {}), ...(filled(name.en) ? { en: name.en } : {}) }
  })
  .pipe(LocalizedNameSchema)

/** A barcode as typed: trimmed, blank means none. */
export const BarcodeInputRule = z
  .string()
  .trim()
  .transform((barcode) => (barcode === '' ? null : barcode))
  .pipe(z.union([z.null(), BarcodeRule]))
  .nullable()

/**
 * A file inside the media folder: relative, `/`-separated, no empty, `.` or `..` segment (a segment
 * starts with a letter, a digit, `_` or `-`).
 */
export const ImagePathRule = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)

/**
 * The VAT rate of a product created without one (quick create at the till): the standard 20 % when
 * the business has it among its `vat.rates`, else the highest rate it has.
 */
export const defaultVatBp = (rates: readonly number[]): number => (rates.includes(2000) ? 2000 : Math.max(...rates))

/** Colour of a category the import has to create. */
export const DEFAULT_CATEGORY_COLOR = '#0FA3A3'

/** What a product has until told otherwise (a fresh object each time: the array is the caller's to keep). */
export const productDefaults = (): Omit<ProductDto, 'id' | 'categoryId' | 'name' | 'priceCents' | 'vatBp' | 'sort'> => ({
  barcode: null,
  soldByWeight: false,
  color: null,
  imagePath: null,
  keySize: 1,
  active: true,
  stockTracked: false,
  stockMilli: 0,
  lowStockMilli: 0,
  course: 0,
  modifierGroupIds: []
})

/** Used to match a category or a product name from a sheet with the ones in the database. */
export const nameKey = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
