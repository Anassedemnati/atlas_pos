import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CatalogDto, ProductDto } from '@shared/dto'
import type { SettingsDto } from '@shared/dto/backoffice'
import { parseMoney } from '@shared/money'
import type { LocalizedName } from '@shared/names'
import { Button, ConfirmDialog, Select, Tabs, TextField, Toggle, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { Drawer } from '../components/Drawer'
import { ImportDialog } from '../components/ImportDialog'
import { NamesFields } from '../components/NamesFields'
import { PageHeader } from '../components/PageHeader'
import { Photo } from '../components/Photo'
import { Switch } from '../components/Switch'
import { centsToInput, inputToMilli, milliToInput, useFormat } from '../format'

/** The form of a product, as typed. */
interface Draft {
  id: string | null
  name: LocalizedName
  price: string
  vatBp: string
  categoryId: string
  barcode: string
  soldByWeight: boolean
  color: string | null
  imagePath: string | null
  keySize: 1 | 2
  active: boolean
  stockTracked: boolean
  stock: string
  lowStock: string
  course: number
  modifierGroupIds: string[]
}

const blank = (categoryId: string, vatBp: number): Draft => ({
  id: null,
  name: { fr: '' },
  price: '',
  vatBp: String(vatBp),
  categoryId,
  barcode: '',
  soldByWeight: false,
  color: null,
  imagePath: null,
  keySize: 1,
  active: true,
  stockTracked: false,
  stock: '',
  lowStock: '',
  course: 0,
  modifierGroupIds: []
})

const fromProduct = (p: ProductDto): Draft => ({
  id: p.id,
  name: { ...p.name },
  price: centsToInput(p.priceCents),
  vatBp: String(p.vatBp),
  categoryId: p.categoryId,
  barcode: p.barcode ?? '',
  soldByWeight: p.soldByWeight,
  color: p.color,
  imagePath: p.imagePath,
  keySize: p.keySize === 2 ? 2 : 1,
  active: p.active,
  stockTracked: p.stockTracked,
  stock: milliToInput(p.stockMilli),
  lowStock: milliToInput(p.lowStockMilli),
  course: p.course,
  modifierGroupIds: [...p.modifierGroupIds]
})

/** What `catalog.saveProduct` takes for an existing product (everything but its position, which only reordering changes). */
const inputOf = ({ sort: _sort, ...rest }: ProductDto) => rest

/** The products: a table with search and filters, an edit drawer, the Excel / CSV import and export. */
export function Products() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const catalog = useQuery<CatalogDto>('/api/catalog')
  const settings = useQuery<SettingsDto>('/api/settings', { silent: true })
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<{ name?: string; price?: string; stock?: string }>({})
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<ProductDto | null>(null)
  const [importing, setImporting] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)

  const data = catalog.data
  const rates = (settings.data?.values['vat.rates'] as number[] | undefined) ?? [2000, 1400, 1000, 700, 0]
  const categories = data?.categories ?? []
  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, f.name(c.name)])), [categories, f])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (data?.products ?? []).filter((p) => {
      if (categoryFilter !== 'all' && p.categoryId !== categoryFilter) return false
      if (status === 'active' && !p.active) return false
      if (status === 'inactive' && p.active) return false
      if (needle === '') return true
      return [p.name.fr, p.name.ar, p.name.en, p.barcode].some((text) => text?.toLowerCase().includes(needle))
    })
  }, [data, search, categoryFilter, status])

  const openNew = () => {
    setErrors({})
    setDraft(blank(categoryFilter !== 'all' ? categoryFilter : (categories[0]?.id ?? ''), rates.includes(1000) ? 1000 : (rates[0] ?? 2000)))
  }
  const openEdit = (product: ProductDto) => {
    setErrors({})
    setDraft(fromProduct(product))
  }

  const save = async () => {
    if (!draft || !data) return
    const next: typeof errors = {}
    if (draft.name.fr.trim() === '') next.name = t('bo.products.errors.name')
    const priceCents = parseMoney(draft.price)
    if (priceCents === null) next.price = t('bo.products.errors.price')
    const stockMilli = draft.stockTracked ? inputToMilli(draft.stock) : 0
    const lowStockMilli = draft.stockTracked ? inputToMilli(draft.lowStock) : 0
    if (stockMilli === null || lowStockMilli === null) next.stock = t('bo.products.errors.stock')
    setErrors(next)
    if (Object.keys(next).length > 0 || priceCents === null || stockMilli === null || lowStockMilli === null) return
    const before = draft.id ? data.products.find((p) => p.id === draft.id) : undefined
    const body = {
      categoryId: draft.categoryId,
      name: draft.name,
      priceCents,
      vatBp: Number(draft.vatBp),
      barcode: draft.barcode.trim(),
      soldByWeight: draft.soldByWeight,
      color: draft.color,
      imagePath: draft.imagePath,
      keySize: draft.keySize,
      active: draft.active,
      stockTracked: draft.stockTracked,
      // The live stock is only overwritten when it was edited here.
      ...(draft.stockTracked && (!before || before.stockMilli !== stockMilli) ? { stockMilli } : {}),
      lowStockMilli,
      course: draft.course,
      modifierGroupIds: draft.modifierGroupIds
    }
    setSaving(true)
    const result = draft.id ? await api.call('PUT', `/api/catalog/products/${draft.id}`, body) : await api.call('POST', '/api/catalog/products', body)
    setSaving(false)
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setDraft(null)
    catalog.reload()
  }

  const toggleActive = async (product: ProductDto, active: boolean) => {
    const result = await api.call('PUT', `/api/catalog/products/${product.id}`, { ...inputOf(product), active })
    if (result.ok) catalog.reload()
  }

  const remove = async () => {
    if (!removing) return
    const result = await api.call<{ outcome: 'deleted' | 'deactivated' }>('DELETE', `/api/catalog/products/${removing.id}`)
    setRemoving(null)
    if (!result.ok) return
    toast.success(t(`bo.products.${result.value.outcome}`))
    setDraft(null)
    catalog.reload()
  }

  const uploadPhoto = async (file: File | undefined) => {
    if (!file || !draft) return
    const result = await api.upload<{ imagePath: string }>('/api/media/products', file)
    if (result.ok) setDraft((current) => (current ? { ...current, imagePath: result.value.imagePath } : current))
    if (photoInput.current) photoInput.current.value = ''
  }

  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current))
  const stockOn = data?.products.some((p) => p.stockTracked) || draft?.stockTracked

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.products')}>
        <TextField label={t('bo.products.search')} hideLabel icon="search" placeholder={t('bo.products.search')} value={search} onChange={setSearch} className="bo-search" data-testid="product-search" />
        <Button variant="ghost" icon="plus" onClick={() => setImporting(true)} data-testid="import-open">
          {t('bo.products.import')}
        </Button>
        <Button icon="plus" onClick={openNew} disabled={categories.length === 0} data-testid="product-new">
          {t('bo.products.new')}
        </Button>
      </PageHeader>

      <div className="cluster">
        <Tabs
          variant="segmented"
          value={status}
          onChange={setStatus}
          aria-label={t('bo.products.status')}
          tabs={[
            { id: 'all', label: t('bo.filter.all') },
            { id: 'active', label: t('bo.filter.active') },
            { id: 'inactive', label: t('bo.filter.inactive') }
          ]}
        />
        <Select
          label={t('bo.products.category')}
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={[{ value: 'all', label: t('bo.filter.allCategories') }, ...categories.map((c) => ({ value: c.id, label: f.name(c.name) }))]}
          className="bo-filter"
        />
        <a className="bo-link" href="/api/catalog/export?format=xlsx" download>
          {t('bo.products.exportXlsx')}
        </a>
        <a className="bo-link" href="/api/catalog/export?format=csv" download>
          {t('bo.products.exportCsv')}
        </a>
      </div>

      <div className="bo-table-wrap">
        <table className="bo-table" data-testid="products-table">
          <thead>
            <tr>
              <th aria-label={t('bo.products.photo')} />
              <th>{t('bo.products.name')}</th>
              <th>{t('bo.products.category')}</th>
              <th className="bo-num">{t('bo.products.price')}</th>
              <th>{t('bo.products.vat')}</th>
              {stockOn && <th className="bo-num">{t('bo.products.stock')}</th>}
              <th>{t('bo.products.active')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((product) => (
              <tr key={product.id} data-testid={`product-row-${product.name.fr}`}>
                <td>
                  <Photo path={product.imagePath} />
                </td>
                <td>
                  <button type="button" className="bo-rowlink" onClick={() => openEdit(product)}>
                    {f.name(product.name)}
                  </button>
                  {product.barcode && <span className="bo-sub">{product.barcode}</span>}
                </td>
                <td>{categoryName.get(product.categoryId) ?? '-'}</td>
                <td className="bo-num figure">
                  {f.money(product.priceCents)}
                  {product.soldByWeight && <span className="bo-sub">{t('bo.products.perKg')}</span>}
                </td>
                <td>{f.vat(product.vatBp)}</td>
                {stockOn && <td className="bo-num">{product.stockTracked ? f.qty(product.stockMilli) : '-'}</td>}
                <td>
                  <Switch checked={product.active} label={t('bo.products.active')} onChange={(active) => void toggleActive(product, active)} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={stockOn ? 7 : 6} className="muted bo-empty">
                  {catalog.loading ? t('common.loading') : t('common.noResults')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? t('bo.products.edit') : t('bo.products.new')}
        testId="product-drawer"
        footer={
          <>
            {draft?.id && (
              <Button variant="danger" size="lg" onClick={() => setRemoving(data?.products.find((p) => p.id === draft.id) ?? null)}>
                {t('common.delete')}
              </Button>
            )}
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void save()} disabled={saving} data-testid="product-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="stack">
            <NamesFields value={draft.name} onChange={(name) => set({ name })} error={errors.name} />
            <div className="bo-grid-2">
              <TextField label={t('bo.products.priceTtc')} inputMode="decimal" value={draft.price} onChange={(price) => set({ price })} error={errors.price} data-testid="product-price" />
              <Select label={t('bo.products.vat')} value={draft.vatBp} onChange={(vatBp) => set({ vatBp })} options={rates.map((bp) => ({ value: String(bp), label: f.vat(bp) }))} />
            </div>
            <Select label={t('bo.products.category')} value={draft.categoryId} onChange={(categoryId) => set({ categoryId })} options={categories.map((c) => ({ value: c.id, label: f.name(c.name) }))} />
            <TextField label={t('bo.products.barcode')} value={draft.barcode} onChange={(barcode) => set({ barcode })} inputMode="numeric" data-testid="product-barcode" />
            <Toggle label={t('bo.products.soldByWeight')} checked={draft.soldByWeight} onChange={(soldByWeight) => set({ soldByWeight })} />
            <Toggle label={t('bo.products.stockTracked')} checked={draft.stockTracked} onChange={(stockTracked) => set({ stockTracked })} />
            {draft.stockTracked && (
              <div className="bo-grid-2">
                <TextField label={t('bo.products.stock')} inputMode="decimal" value={draft.stock} onChange={(stock) => set({ stock })} error={errors.stock} />
                <TextField label={t('bo.products.lowStock')} inputMode="decimal" value={draft.lowStock} onChange={(lowStock) => set({ lowStock })} />
              </div>
            )}
            <div className="bo-grid-2">
              <label className="field">
                <span className="field__label">{t('bo.products.color')}</span>
                <span className="bo-color">
                  <input type="color" value={draft.color ?? '#0FA3A3'} onChange={(event) => set({ color: event.target.value.toUpperCase() })} aria-label={t('bo.products.color')} data-testid="product-color" />
                  {draft.color ? (
                    <Button variant="ghost" onClick={() => set({ color: null })}>
                      {t('common.clear')}
                    </Button>
                  ) : (
                    <span className="muted">{t('bo.products.categoryColor')}</span>
                  )}
                </span>
              </label>
              <Select label={t('bo.products.keySize')} value={String(draft.keySize)} onChange={(size) => set({ keySize: size === '2' ? 2 : 1 })} options={[{ value: '1', label: t('bo.products.keySize1') }, { value: '2', label: t('bo.products.keySize2') }]} />
            </div>
            {(data?.modifierGroups ?? []).length > 0 && (
              <div className="field">
                <span className="field__label">{t('bo.products.optionGroups')}</span>
                {(data?.modifierGroups ?? []).map((group) => (
                  <Toggle
                    key={group.id}
                    label={f.name(group.name)}
                    checked={draft.modifierGroupIds.includes(group.id)}
                    onChange={(on) => set({ modifierGroupIds: on ? [...draft.modifierGroupIds, group.id] : draft.modifierGroupIds.filter((id) => id !== group.id) })}
                  />
                ))}
              </div>
            )}
            <div className="field">
              <span className="field__label">{t('bo.products.photo')}</span>
              <div className="cluster">
                <Photo path={draft.imagePath} size={72} />
                <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="photo-input" onChange={(event) => void uploadPhoto(event.target.files?.[0])} />
                <Button variant="ghost" onClick={() => photoInput.current?.click()}>
                  {t('bo.products.choosePhoto')}
                </Button>
                {draft.imagePath && (
                  <Button variant="ghost" onClick={() => set({ imagePath: null })}>
                    {t('bo.products.removePhoto')}
                  </Button>
                )}
              </div>
              <p className="field__message">{t('bo.products.photoHint')}</p>
            </div>
            <Toggle label={t('bo.products.active')} checked={draft.active} onChange={(active) => set({ active })} />
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={removing !== null}
        tone="danger"
        title={t('bo.products.deleteTitle')}
        message={removing ? t('bo.products.deleteMessage', { name: removing.name.fr }) : ''}
        confirmLabel={t('common.delete')}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={catalog.reload} />
    </div>
  )
}
