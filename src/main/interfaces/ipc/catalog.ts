import type { catalogChannels } from '@shared/ipc/catalog'
import { parseCatalogSheet } from '../../infrastructure/import/catalog-sheet'
import { ok, overrideToken as token, type Handlers } from './context'

/** Categories, products, modifiers, menus, stock, the Excel / CSV sheet. */
export const catalogHandlers: Handlers<keyof typeof catalogChannels> = {
  'catalog.list': (_input, ctx) => ok(ctx.services().catalog.listCatalog()),
  'catalog.saveCategory': (input, ctx) => ctx.services().catalog.saveCategory(ctx.session(), input),
  'catalog.deleteCategory': ({ id }, ctx) => ctx.services().catalog.deleteCategory(ctx.session(), id),
  'catalog.saveProduct': (input, ctx) => ctx.services().catalog.saveProduct(ctx.session(), input),
  'catalog.deleteProduct': ({ id }, ctx) => ctx.services().catalog.deleteProduct(ctx.session(), id),
  'catalog.quickCreateProduct': ({ barcode, name, priceCents, categoryId, overrideTokenId }, ctx) =>
    ctx.services().catalog.quickCreateProduct(ctx.session(), barcode, name, priceCents, categoryId, token(overrideTokenId)),
  'catalog.adjustStock': ({ productId, deltaMilli, reason }, ctx) =>
    ctx.services().catalog.adjustStock(ctx.session(), productId, deltaMilli, reason),
  'catalog.saveModifierGroup': (input, ctx) => ctx.services().catalog.saveModifierGroup(ctx.session(), input),
  'catalog.saveMenu': (input, ctx) => ctx.services().catalog.saveMenu(ctx.session(), input),
  'catalog.reorder': ({ kind, ids }, ctx) => ctx.services().catalog.reorder(ctx.session(), kind, ids),
  // The parser refuses a file over its size limit itself (`errors.import_too_large`).
  'catalog.previewImport': ({ bytes, fileName }, ctx) =>
    ok(parseCatalogSheet(bytes, fileName, ctx.services().settings.get('vat.rates'))),
  'catalog.applyImport': ({ rows, mode }, ctx) => ctx.services().catalog.applyCatalogImport(ctx.session(), rows, mode),
  'catalog.exportSheet': ({ format }, ctx) => {
    const buffer = ctx.services().catalog.exportCatalogSheet(format)
    // A copy: a view on the Buffer's pool would carry the whole pool across IPC.
    return ok({ bytes: new Uint8Array(buffer), fileName: `catalogue.${format}` })
  }
}
