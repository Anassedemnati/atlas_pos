import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CatalogDto, ProductDto } from '@shared/dto'
import { Select, Tabs } from '../../ui'
import { useApi, useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { SortableList } from '../components/SortableList'
import { useFormat } from '../format'

/** An edit without the position and without the live stock (the copy loaded here may be older than the till's sales). */
const inputOf = ({ sort: _sort, stockMilli: _stock, ...rest }: ProductDto) => rest

/** The key layouts of the till: the order of the category tabs, and the order and size of the product keys of each. */
export function Keyboards() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const catalog = useQuery<CatalogDto>('/api/catalog')
  const [tab, setTab] = useState<'categories' | 'products'>('categories')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  // The order shown right away, before the server has answered.
  const [order, setOrder] = useState<{ kind: 'category' | 'product'; ids: string[] } | null>(null)
  const data = catalog.data
  const categories = data?.categories ?? []

  useEffect(() => setOrder(null), [data])

  useEffect(() => {
    if (categoryId === null && categories[0]) setCategoryId(categories[0].id)
  }, [categories, categoryId])

  const reorder = async (kind: 'category' | 'product', ids: string[]) => {
    setOrder({ kind, ids })
    const result = await api.call('POST', '/api/catalog/reorder', { kind, ids })
    // The shown order stays until the reloaded catalogue replaces it (below); a refusal puts the old one back.
    if (!result.ok) setOrder(null)
    catalog.reload()
  }

  const sorted = <T extends { id: string }>(items: T[], kind: 'category' | 'product'): T[] => {
    if (order?.kind !== kind) return items
    const position = new Map(order.ids.map((id, index) => [id, index]))
    return [...items].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
  }

  const products = sorted((data?.products ?? []).filter((p) => p.categoryId === categoryId), 'product')

  const setSize = async (product: ProductDto, size: string) => {
    const result = await api.call('PUT', `/api/catalog/products/${product.id}`, { ...inputOf(product), keySize: size === '2' ? 2 : 1 })
    if (result.ok) catalog.reload()
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.keyboards')} />
      <p className="muted">{t('bo.keyboards.hint')}</p>
      <Tabs
        variant="segmented"
        value={tab}
        onChange={setTab}
        aria-label={t('bo.nav.keyboards')}
        tabs={[
          { id: 'categories', label: t('bo.keyboards.categories') },
          { id: 'products', label: t('bo.keyboards.products') }
        ]}
      />
      {tab === 'categories' && (
        <SortableList
          testId="sortable-categories"
          items={sorted(categories, 'category').map((c) => ({
            id: c.id,
            content: (
              <span className="bo-keyrow">
                <span className="bo-swatch" style={{ background: c.color }} />
                {f.name(c.name)}
              </span>
            )
          }))}
          onReorder={(ids) => void reorder('category', ids)}
        />
      )}
      {tab === 'products' && (
        <>
          <Select label={t('bo.products.category')} value={categoryId} onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: f.name(c.name) }))} className="bo-filter" />
          {products.length === 0 ? (
            <p className="muted">{t('common.noResults')}</p>
          ) : (
            <SortableList
              testId="sortable-products"
              items={products.map((p) => ({
                id: p.id,
                content: (
                  <span className="bo-keyrow">
                    <span className={`bo-key bo-key--${p.keySize === 2 ? 2 : 1}`} style={{ background: p.color ?? categories.find((c) => c.id === p.categoryId)?.color ?? '#0FA3A3' }}>
                      {f.name(p.name)}
                    </span>
                    <Select label={t('bo.products.keySize')} value={String(p.keySize === 2 ? 2 : 1)} onChange={(size) => void setSize(p, size)} options={[{ value: '1', label: t('bo.products.keySize1') }, { value: '2', label: t('bo.products.keySize2') }]} className="bo-keysize" />
                  </span>
                )
              }))}
              onReorder={(ids) => void reorder('product', ids)}
            />
          )}
        </>
      )}
    </div>
  )
}
