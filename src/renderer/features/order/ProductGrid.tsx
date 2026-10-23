import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { CategoryDto, ProductDto } from '@shared/dto'
import { mediaUrl } from '@shared/media'
import { Button, Icon, Tabs, TextField, type TabItem } from '../../ui'
import { formatQty, useFormat } from '../till/format'

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

export interface ProductGridProps {
  categories: CategoryDto[]
  products: ProductDto[]
  activeCategory: string
  onCategory: (id: string) => void
  onPick: (product: ProductDto) => void
  search: string
  onSearch: (text: string) => void
  keyStyle: 'color' | 'photo'
  /** Shows the stock of tracked products (the stock module). */
  showStock: boolean
  qty: string
  onQty: (text: string) => void
}

/** A product key: a colour band, or the photo when the business uses photo keys and the product has one. */
function ProductKey({ product, color, photo, showStock, onPick }: { product: ProductDto; color: string; photo: boolean; showStock: boolean; onPick: () => void }) {
  const { t } = useTranslation()
  const { money, name } = useFormat()
  const [failed, setFailed] = useState(false)
  const url = photo && !failed ? mediaUrl(product.imagePath) : null
  const low = product.stockTracked && product.stockMilli <= product.lowStockMilli
  const style = { '--key-color': product.color ?? color, gridColumn: product.keySize === 2 ? 'span 2' : undefined } as CSSProperties
  return (
    <button type="button" className={url ? 'product-key product-key--photo' : 'product-key'} style={style} onClick={onPick} data-testid={`product-${product.id}`} aria-label={name(product.name)}>
      {url ? <img className="product-key__image" src={url} alt="" draggable={false} onError={() => setFailed(true)} /> : <span className="product-key__band" />}
      <span className="product-key__name">{name(product.name)}</span>
      <span className="product-key__price figure">
        {money(product.priceCents)}
        {product.soldByWeight && <small> / kg</small>}
      </span>
      {showStock && product.stockTracked && (
        <span className={low ? 'product-key__stock product-key__stock--low' : 'product-key__stock'} data-testid={`stock-${product.id}`}>
          {low && <Icon name="warning" size={16} />}
          {t('order.stock', { qty: formatQty(product.stockMilli) })}
        </span>
      )}
    </button>
  )
}

/** The right-hand side of the order pad: category tabs, search, the product keys and the quantity keys. */
export function ProductGrid(props: ProductGridProps) {
  const { t } = useTranslation()
  const { name } = useFormat()
  const [searching, setSearching] = useState(false)
  const query = props.search.trim().toLocaleLowerCase()
  const categoryColor = new Map(props.categories.map((c) => [c.id, c.color]))
  const tabs: TabItem[] = props.categories.map((c) => ({ id: c.id, label: name(c.name), color: c.color }))
  const shown = query
    ? props.products.filter((p) => name(p.name).toLocaleLowerCase().includes(query) || (p.barcode ?? '').includes(query))
    : props.products.filter((p) => p.categoryId === props.activeCategory)

  return (
    <section className="catalog" data-testid="catalog">
      <div className="catalog__tabs">
        <div className="catalog__tabs-scroll">
          <Tabs tabs={tabs} value={props.activeCategory} onChange={(id) => { props.onSearch(''); props.onCategory(id) }} aria-label={t('order.categories')} />
        </div>
        <Button variant={searching ? 'primary' : 'secondary'} icon="search" onClick={() => { setSearching(!searching); props.onSearch('') }} aria-label={t('common.search')} data-testid="toggle-search" />
      </div>
      {searching && <TextField label={t('common.search')} hideLabel icon="search" value={props.search} onChange={props.onSearch} placeholder={t('order.searchPlaceholder')} autoFocus data-testid="search-field" />}
      <div className="product-grid" data-testid="product-grid">
        {shown.map((product) => (
          <ProductKey
            key={product.id}
            product={product}
            color={categoryColor.get(product.categoryId) ?? '#0fa3a3'}
            photo={props.keyStyle === 'photo'}
            showStock={props.showStock}
            onPick={() => props.onPick(product)}
          />
        ))}
        {shown.length === 0 && <p className="muted">{t('common.noResults')}</p>}
      </div>
      <div className="qtypad" dir="ltr">
        <span className="qtypad__label">
          {t('order.quantity')}
          {props.qty && <strong className="figure" data-testid="qty-buffer"> × {props.qty}</strong>}
        </span>
        <div className="qtypad__keys">
          {DIGITS.map((digit) => (
            <button key={digit} type="button" className="qtypad__key" onClick={() => props.onQty((props.qty + digit).slice(0, 3))} data-testid={`qty-${digit}`}>
              {digit}
            </button>
          ))}
          <button type="button" className="qtypad__key qtypad__key--muted" onClick={() => props.onQty(props.qty.slice(0, -1))} aria-label={t('keypad.backspace')}>
            <Icon name="backspace" size={28} />
          </button>
        </div>
      </div>
    </section>
  )
}
