import { z } from 'zod'
import type { CatalogDto, ImportRow, ImportSummary, ParsedCatalogSheet } from '../dto'
import { bytes, def, id, int, localizedName, none, text, tokenId } from './define'

const nullableText = z.string().max(500).nullable()

const product = z.strictObject({
  id: id.optional(),
  categoryId: id,
  name: localizedName,
  priceCents: int,
  vatBp: int,
  barcode: z.string().max(64).nullable().optional(),
  soldByWeight: z.boolean().optional(),
  color: nullableText.optional(),
  imagePath: nullableText.optional(),
  keySize: int.optional(),
  active: z.boolean().optional(),
  stockTracked: z.boolean().optional(),
  stockMilli: int.optional(),
  lowStockMilli: int.optional(),
  course: int.optional(),
  modifierGroupIds: z.array(id).max(100).optional()
})

const importRow = z.strictObject({
  row: int,
  category: z.string(),
  nameFr: z.string(),
  nameAr: z.string().optional(),
  nameEn: z.string().optional(),
  priceCents: int,
  vatBp: int,
  barcode: z.string().optional(),
  soldByWeight: z.boolean(),
  stockMilli: int.optional(),
  color: z.string().optional()
}) satisfies z.ZodType<ImportRow>

/** Categories, products, modifiers, set menus, stock and the Excel / CSV sheet. Changes need `catalog.manage`. */
export const catalogChannels = {
  'catalog.list': def<CatalogDto>()(none, 'session'),
  'catalog.saveCategory': def<{ id: string }>()(
    z.strictObject({
      id: id.optional(),
      name: localizedName,
      color: z.string().max(16).optional(),
      active: z.boolean().optional(),
      imagePath: nullableText.optional()
    }),
    'session'
  ),
  'catalog.deleteCategory': def<{ id: string }>()(z.strictObject({ id }), 'session'),
  'catalog.saveProduct': def<{ id: string }>()(product, 'session'),
  'catalog.deleteProduct': def<{ outcome: 'deleted' | 'deactivated' }>()(z.strictObject({ id }), 'session'),
  /** A product for a barcode the scanner did not find; a cashier needs a manager's approval (`catalog.manage`). */
  'catalog.quickCreateProduct': def<{ id: string }>()(
    z.strictObject({ barcode: z.string().max(64), name: z.string().max(200), priceCents: int, categoryId: id, overrideTokenId: tokenId }),
    'session'
  ),
  'catalog.adjustStock': def<{ stockMilli: number }>()(
    z.strictObject({ productId: id, deltaMilli: int, reason: text }),
    'session'
  ),
  'catalog.saveModifierGroup': def<{ id: string }>()(
    z.strictObject({
      id: id.optional(),
      name: localizedName,
      minSelect: int.optional(),
      maxSelect: int.optional(),
      modifiers: z.array(z.strictObject({ id: id.optional(), name: localizedName, priceDeltaCents: int.optional() })).max(200)
    }),
    'session'
  ),
  'catalog.saveMenu': def<{ id: string }>()(
    z.strictObject({
      productId: id,
      courses: z
        .array(
          z.strictObject({
            name: localizedName,
            chooseCount: int.optional(),
            items: z.array(z.strictObject({ productId: id, supplementCents: int.optional() })).max(200)
          })
        )
        .max(20)
    }),
    'session'
  ),
  'catalog.reorder': def<true>()(
    z.strictObject({ kind: z.enum(['category', 'product', 'modifierGroup']), ids: z.array(id).max(10000) }),
    'session'
  ),
  /** Reads a sheet the user picked (the bytes of the file): the valid rows and every problem. Nothing is written. */
  'catalog.previewImport': def<ParsedCatalogSheet>()(
    z.strictObject({ bytes, fileName: z.string().min(1).max(260) }),
    { permission: 'catalog.manage' }
  ),
  /** Writes previewed rows (only from a sheet without errors). */
  'catalog.applyImport': def<ImportSummary>()(
    z.strictObject({ rows: z.array(importRow).max(5000), mode: z.enum(['merge', 'replace']) }),
    'session'
  ),
  /** The catalogue as a sheet the import reads back. */
  'catalog.exportSheet': def<{ bytes: Uint8Array; fileName: string }>()(
    z.strictObject({ format: z.enum(['xlsx', 'csv']) }),
    { permission: 'catalog.manage' }
  )
}
