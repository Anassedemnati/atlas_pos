import type { ProductDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { IdRule, defaultVatBp, productDefaults } from '../../../domain/catalog/fields'
import {
  ProductInputSchema,
  QuickCreateSchema,
  StockAdjustmentSchema,
  type ProductInput
} from '../../../domain/catalog/inputs'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { SettingsRepo } from '../../../infrastructure/db/repos/settings-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { logChange, parseInput } from './input'

export interface ProductUseCases {
  /**
   * Creates (no `id`) or edits a product. Needs `catalog.manage`. The rules of every field are the
   * ones of the setup profile, and the VAT rate must be one of the `vat.rates` setting
   * (`invalid_vat`, `params.allowed`). A barcode another product holds is `barcode_taken`; a blank one
   * is none. A new product goes last; on an edit a field left out is kept (`null` clears the barcode,
   * colour and image).
   * `stockMilli` is the starting quantity: it is taken for a new product and for one that starts being
   * tracked, and ignored for a product that already tracks its stock (its quantity moves with sales and
   * `adjustStock`, which is audited with a reason).
   */
  saveProduct(session: Session, input: ProductInput): Result<{ id: string }>
  /**
   * Needs `catalog.manage`. A product that was sold (an order line) or is offered in a set menu is
   * made inactive (`deactivated`): the history keeps pointing at it. Any other is removed with its
   * own menu (`deleted`).
   */
  deleteProduct(session: Session, id: string): Result<{ outcome: 'deleted' | 'deactivated' }>
  /**
   * Needs `catalog.manage` (a manager at the till). A product for a barcode the scan did not find:
   * French name, VAT 20 % (the highest rate of `vat.rates` when the business has no 20 %), no stock
   * tracking; everything else is edited later.
   */
  quickCreateProduct(
    session: Session,
    barcode: string,
    name: string,
    priceCents: number,
    categoryId: string
  ): Result<{ id: string }>
  /**
   * Needs `catalog.manage`. Adds `deltaMilli` (not 0, may be negative) to the stock of a product that
   * tracks it and logs the delta, the reason and the new quantity. The quantity may go below 0 (an
   * oversold item is a fact, not an error). Returns the new quantity.
   */
  adjustStock(session: Session, productId: string, deltaMilli: number, reason: string): Result<{ stockMilli: number }>
}

export function createProductUseCases(deps: {
  repo: CatalogRepo
  uow: UnitOfWork
  settings: SettingsRepo
}): ProductUseCases {
  const { repo, uow, settings } = deps

  const assertBarcodeFree = (barcode: string | null, ownerId: string | undefined): void => {
    if (barcode === null) return
    const holder = repo.findProductByBarcode(barcode)
    if (holder !== undefined && holder !== ownerId) throw new AppErrorException('barcode_taken', { barcode })
  }

  function save(session: Session, raw: ProductInput): { id: string } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(ProductInputSchema, raw)
    return uow.run((tx) => {
      const existing = input.id === undefined ? undefined : repo.getProduct(input.id)
      if (input.id !== undefined && !existing) throw invalidInput('id', 'unknown product')
      if (!repo.getCategory(input.categoryId)) throw invalidInput('categoryId', 'unknown category')
      const groupIds = input.modifierGroupIds ?? existing?.modifierGroupIds ?? []
      if (repo.firstMissing('modifierGroup', groupIds) !== undefined) {
        throw invalidInput('modifierGroupIds', 'unknown modifier group')
      }
      const barcode = input.barcode === undefined ? (existing?.barcode ?? null) : input.barcode
      assertBarcodeFree(barcode, existing?.id)
      const allowed = settings.get('vat.rates')
      if (!allowed.includes(input.vatBp)) {
        throw new AppErrorException('invalid_vat', { field: 'vatBp', vatBp: input.vatBp, allowed })
      }

      const base: ProductDto = existing ?? {
        ...productDefaults(),
        id: newId(),
        categoryId: input.categoryId,
        name: input.name,
        priceCents: input.priceCents,
        vatBp: input.vatBp,
        sort: repo.nextSort('product')
      }
      const product: ProductDto = {
        ...base,
        categoryId: input.categoryId,
        name: input.name,
        priceCents: input.priceCents,
        vatBp: input.vatBp,
        barcode,
        soldByWeight: input.soldByWeight ?? base.soldByWeight,
        color: input.color === undefined ? base.color : input.color,
        imagePath: input.imagePath === undefined ? base.imagePath : input.imagePath,
        keySize: input.keySize ?? base.keySize,
        active: input.active ?? base.active,
        stockTracked: input.stockTracked ?? base.stockTracked,
        // The quantity of a product that already tracks its stock is not the form's to set.
        stockMilli: existing?.stockTracked ? existing.stockMilli : (input.stockMilli ?? base.stockMilli),
        lowStockMilli: input.lowStockMilli ?? base.lowStockMilli,
        course: input.course ?? base.course,
        modifierGroupIds: groupIds
      }
      if (existing) repo.updateProduct(tx, product)
      else repo.insertProduct(tx, product)
      repo.setProductGroups(tx, product.id, groupIds)
      logChange(tx, session, {
        type: 'product.saved',
        entity: 'product',
        entityId: product.id,
        data: {
          created: !existing,
          stockMilli: product.stockMilli,
          ...(existing && existing.stockMilli !== product.stockMilli ? { previousStockMilli: existing.stockMilli } : {})
        }
      })
      return { id: product.id }
    })
  }

  function remove(session: Session, rawId: string): { outcome: 'deleted' | 'deactivated' } {
    requirePermission(session, 'catalog.manage')
    const id = parseInput(IdRule, rawId)
    return uow.run((tx) => {
      const product = repo.getProduct(id)
      if (!product) throw invalidInput('id', 'unknown product')
      const outcome = repo.isProductReferenced(id) ? 'deactivated' : 'deleted'
      if (outcome === 'deactivated') repo.updateProduct(tx, { ...product, active: false })
      else repo.deleteProduct(tx, id)
      // The name is logged because the row may be gone.
      logChange(tx, session, {
        type: 'product.deleted',
        entity: 'product',
        entityId: id,
        data: { outcome, name: product.name.fr }
      })
      return { outcome }
    })
  }

  function quickCreate(
    session: Session,
    rawBarcode: string,
    name: string,
    priceCents: number,
    categoryId: string
  ): { id: string } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(QuickCreateSchema, { barcode: rawBarcode, name: { fr: name }, priceCents, categoryId })
    const barcode = input.barcode as string
    return uow.run((tx) => {
      if (!repo.getCategory(input.categoryId)) throw invalidInput('categoryId', 'unknown category')
      assertBarcodeFree(barcode, undefined)
      const product: ProductDto = {
        ...productDefaults(),
        id: newId(),
        categoryId: input.categoryId,
        name: input.name,
        priceCents: input.priceCents,
        vatBp: defaultVatBp(settings.get('vat.rates')),
        barcode,
        sort: repo.nextSort('product')
      }
      repo.insertProduct(tx, product)
      logChange(tx, session, {
        type: 'product.quick_created',
        entity: 'product',
        entityId: product.id,
        data: { barcode, priceCents: product.priceCents }
      })
      return { id: product.id }
    })
  }

  function adjust(session: Session, productId: string, deltaMilli: number, reason: string): { stockMilli: number } {
    requirePermission(session, 'catalog.manage')
    const input = parseInput(StockAdjustmentSchema, { productId, deltaMilli, reason })
    return uow.run((tx) => {
      const product = repo.getProduct(input.productId)
      if (!product) throw invalidInput('productId', 'unknown product')
      if (!product.stockTracked) throw new AppErrorException('stock_not_tracked')
      const stockMilli = repo.addStock(tx, product.id, input.deltaMilli)
      logChange(tx, session, {
        type: 'stock.adjusted',
        entity: 'product',
        entityId: product.id,
        data: { deltaMilli: input.deltaMilli, reason: input.reason, stockMilli }
      })
      return { stockMilli }
    })
  }

  return {
    saveProduct: (session, input) => attemptSync(() => save(session, input)),
    deleteProduct: (session, id) => attemptSync(() => remove(session, id)),
    quickCreateProduct: (session, barcode, name, priceCents, categoryId) =>
      attemptSync(() => quickCreate(session, barcode, name, priceCents, categoryId)),
    adjustStock: (session, productId, deltaMilli, reason) =>
      attemptSync(() => adjust(session, productId, deltaMilli, reason))
  }
}
