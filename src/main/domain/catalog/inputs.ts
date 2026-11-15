import { z } from 'zod'
import {
  BarcodeInputRule,
  ChooseCountRule,
  ColorRule,
  CourseRule,
  IdRule,
  ImagePathRule,
  KeySizeRule,
  LowStockMilliRule,
  MaxSelectRule,
  MinSelectRule,
  NameRule,
  PriceCentsRule,
  PriceDeltaRule,
  StockMilliRule,
  SupplementRule,
  VatBpRule
} from './fields'

// What the back office sends. On an edit (`id` present) a field left out is kept; on a creation it
// takes its default. `null` clears the fields that may be empty.

export const CategoryInputSchema = z.strictObject({
  id: IdRule.optional(),
  name: NameRule,
  color: ColorRule.optional(),
  active: z.boolean().optional(),
  imagePath: ImagePathRule.nullable().optional()
})
export type CategoryInput = z.input<typeof CategoryInputSchema>

const uniqueIds = (ids: string[]): boolean => new Set(ids).size === ids.length

export const ProductInputSchema = z.strictObject({
  id: IdRule.optional(),
  categoryId: IdRule,
  name: NameRule,
  priceCents: PriceCentsRule,
  vatBp: VatBpRule,
  barcode: BarcodeInputRule.optional(),
  soldByWeight: z.boolean().optional(),
  color: ColorRule.nullable().optional(),
  imagePath: ImagePathRule.nullable().optional(),
  keySize: KeySizeRule.optional(),
  active: z.boolean().optional(),
  stockTracked: z.boolean().optional(),
  stockMilli: StockMilliRule.optional(),
  lowStockMilli: LowStockMilliRule.optional(),
  course: CourseRule.optional(),
  modifierGroupIds: z.array(IdRule).refine(uniqueIds, { message: 'duplicate group' }).optional()
})
export type ProductInput = z.input<typeof ProductInputSchema>

export const QuickCreateSchema = z.strictObject({
  barcode: BarcodeInputRule.refine((barcode) => barcode !== null, { message: 'a barcode is required' }),
  name: NameRule,
  priceCents: PriceCentsRule,
  categoryId: IdRule
})

export const ModifierGroupInputSchema = z
  .strictObject({
    id: IdRule.optional(),
    name: NameRule,
    minSelect: MinSelectRule.default(0),
    maxSelect: MaxSelectRule.default(1),
    modifiers: z
      .array(
        z.strictObject({
          /** Keeps the modifier (and its id) of the group; absent adds a new one. */
          id: IdRule.optional(),
          name: NameRule,
          priceDeltaCents: PriceDeltaRule.default(0)
        })
      )
      .min(1)
  })
  .refine((group) => group.minSelect <= group.maxSelect, {
    message: 'min_select is greater than max_select',
    path: ['minSelect']
  })
export type ModifierGroupInput = z.input<typeof ModifierGroupInputSchema>

export const MenuInputSchema = z.strictObject({
  /** A product has at most one menu: saving again replaces its courses. */
  productId: IdRule,
  courses: z
    .array(
      z.strictObject({
        name: NameRule,
        chooseCount: ChooseCountRule.default(1),
        items: z
          .array(z.strictObject({ productId: IdRule, supplementCents: SupplementRule.default(0) }))
          .min(1)
      })
    )
    .min(1)
})
export type MenuInput = z.input<typeof MenuInputSchema>

export const REORDER_KINDS = ['category', 'product', 'modifierGroup'] as const
export type ReorderKind = (typeof REORDER_KINDS)[number]

export const ReorderSchema = z.strictObject({
  kind: z.enum(REORDER_KINDS),
  ids: z.array(IdRule).refine(uniqueIds, { message: 'duplicate id' })
})

export const StockAdjustmentSchema = z.strictObject({
  productId: IdRule,
  deltaMilli: z
    .number()
    .int()
    .refine((delta) => delta !== 0, { message: 'a zero adjustment changes nothing' }),
  reason: z.string().trim().min(1).max(200)
})
