import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuDto, OrderDto, OrderLineDto, ProductDto } from '@shared/dto'
import { invoke, useApi, useEvent } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, useToast } from '../../ui'
import { TillLayout } from '../till/TillLayout'
import { firstToken, useGuard } from '../till/Override'
import { useFormat } from '../till/format'
import { moduleOn, setting, useTill } from '../till/store'
import { DiscountDialog } from './DiscountDialog'
import { LineSheet } from './LineSheet'
import { ParkedDialog } from './ParkedDialog'
import { ProductGrid } from './ProductGrid'
import { ScanBar } from './ScanBar'
import { SplitDialog } from './SplitDialog'
import { TicketPanel } from './TicketPanel'
import { MenuDialog, ModifierDialog, WeightDialog } from './dialogs'
import { useQuery } from '../../app/api'

type Dialog =
  | null
  | { kind: 'weight'; product: ProductDto; qtyMilli: number }
  | { kind: 'menu'; product: ProductDto; menu: MenuDto; qtyMilli: number }
  | { kind: 'modifiers'; product: ProductDto; qtyMilli: number }
  | { kind: 'line'; line: OrderLineDto }
  | { kind: 'discount' }
  | { kind: 'split' }
  | { kind: 'parked' }

/** The order screen of a table (`#/order/:id`) or of the counter (`#/counter`, the order opens with its first item). */
export function OrderScreen({ orderId }: { orderId: string | null }) {
  const { t } = useTranslation()
  const { tableName } = useFormat()
  const [order, setOrder] = useState<OrderDto | null>(null)
  return (
    <TillLayout
      title={t('order.title')}
      badge={order?.tableLabel ? tableName(order.tableLabel) : undefined}
      end={
        <Button variant="secondary" icon="back" onClick={() => navigate('/home')} data-testid="back-home">
          {order?.type === 'dine_in' ? t('order.backTables') : t('order.backHome')}
        </Button>
      }
    >
      <OrderPad orderId={orderId} order={order} setOrder={setOrder} />
    </TillLayout>
  )
}

function OrderPad({ orderId, order, setOrder }: { orderId: string | null; order: OrderDto | null; setOrder: (order: OrderDto | null) => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const { guard } = useGuard()
  const data = useTill()
  const { catalog } = data
  const kitchen = moduleOn(data, 'kitchen')
  const barcodeOn = moduleOn(data, 'barcode')
  const stockOn = moduleOn(data, 'stock')
  const businessType = setting<string>(data, 'business.type', 'restaurant')
  const ticketSide = setting<'start' | 'end'>(data, 'ui.ticketSide', 'start')
  const keyStyle = setting<'color' | 'photo'>(data, 'ui.keyStyle', 'color')

  const categories = catalog.categories.filter((c) => c.active).sort((a, b) => a.sort - b.sort)
  const products = catalog.products.filter((p) => p.active).sort((a, b) => a.sort - b.sort)
  const [category, setCategory] = useState(categories[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [qty, setQty] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [counterType, setCounterType] = useState<'counter' | 'takeaway'>('counter')
  const [busy, setBusy] = useState(false)
  const opening = useRef<Promise<OrderDto | null> | null>(null)
  const parked = useQuery('orders.list', {}, { silent: true, refreshOn: ['order.changed'], enabled: orderId === null })

  // An existing order: read it; a parked one is taken back.
  const load = useCallback(async () => {
    if (!orderId) return
    const result = await invoke('orders.get', { orderId })
    if (!result.ok) return void navigate('/home')
    if (result.value.status === 'parked') {
      const resumed = await invoke('orders.resume', { orderId })
      if (resumed.ok) return void setOrder(resumed.value)
    }
    if (result.value.status !== 'open') return void navigate('/home')
    setOrder(result.value)
  }, [orderId, setOrder])
  useEffect(() => {
    void load()
  }, [load])
  useEvent('order.changed', (event) => {
    if (orderId && event.orderId === orderId) void load()
  })

  // The customer display follows the order on screen.
  useEffect(() => {
    if (!order) return
    void invoke('display.update', { orderId: order.id })
  }, [order])
  useEffect(() => () => void invoke('display.update', { orderId: null }), [])

  /** The order, opened now if the counter had none yet (a number is spent only when there is a first item). */
  const ensure = async (): Promise<OrderDto | null> => {
    if (order) return order
    if (!opening.current) {
      opening.current = invoke('orders.open', { type: counterType }).then((result) => {
        opening.current = null
        if (!result.ok) {
          toast.error(t(result.error.messageKey, { defaultValue: result.error.code }))
          return null
        }
        setOrder(result.value)
        return result.value
      })
    }
    return opening.current
  }

  const takeQty = (): number => {
    const count = Number(qty || '1') || 1
    setQty('')
    return count * 1000
  }

  const commit = async (product: ProductDto, line: { qtyMilli: number; modifierIds?: string[]; note?: string; menuChoices?: { courseId: string; productIds: string[] }[] }) => {
    const target = await ensure()
    if (!target) return
    setBusy(true)
    const result = await guard((tokens) =>
      invoke('orders.addLine', {
        orderId: target.id,
        line: { productId: product.id, qtyMilli: line.qtyMilli, ...(line.modifierIds?.length ? { modifierIds: line.modifierIds } : {}), ...(line.note ? { note: line.note } : {}), ...(line.menuChoices ? { menuChoices: line.menuChoices } : {}) },
        overrideTokenId: firstToken(tokens)
      })
    )
    setBusy(false)
    if (result.ok) setOrder(result.value)
  }

  const pick = (product: ProductDto) => {
    if (product.soldByWeight) return setDialog({ kind: 'weight', product, qtyMilli: 0 })
    const menu = catalog.menus.find((m) => m.productId === product.id)
    if (menu) return setDialog({ kind: 'menu', product, menu, qtyMilli: takeQty() })
    if (product.modifierGroupIds.length > 0) return setDialog({ kind: 'modifiers', product, qtyMilli: takeQty() })
    void commit(product, { qtyMilli: takeQty() })
  }

  const scan = async (barcode: string): Promise<boolean> => {
    const product = catalog.products.find((p) => p.barcode === barcode && p.active)
    if (!product) return false
    pick(product)
    return true
  }

  /** A product a manager just created from an unknown barcode: read the catalogue again and sell one. */
  const addCreated = async (id: string) => {
    const result = await invoke('catalog.list', {})
    const product = result.ok ? result.value.products.find((p) => p.id === id) : undefined
    if (product) await commit(product, { qtyMilli: 1000 })
  }

  const call = async (run: () => Promise<{ ok: true; value: OrderDto } | { ok: false }>) => {
    setBusy(true)
    const result = await run()
    setBusy(false)
    if (result.ok) setOrder(result.value)
    return result.ok
  }

  const send = () => order && call(() => api.call('orders.sendToKitchen', { orderId: order.id }))
  const nextCourse = () => order && call(() => api.call('orders.sendNextCourse', { orderId: order.id }))
  const prebill = async () => {
    if (!order) return
    if (await call(() => api.call('orders.printPrebill', { orderId: order.id }))) toast.success(t('order.prebillPrinted'))
  }
  const park = async () => {
    if (!order) return
    const result = await api.call('orders.park', { orderId: order.id })
    if (result.ok) navigate('/home')
  }

  const ticket = (
    <TicketPanel
      order={order}
      counterType={counterType}
      {...(orderId === null && !order && businessType === 'cafe' ? { onCounterType: setCounterType } : {})}
      kitchen={kitchen}
      canPrebill={order?.type === 'dine_in'}
      canSplit={order?.type === 'dine_in'}
      busy={busy}
      onLine={(line) => setDialog({ kind: 'line', line })}
      onSend={() => void send()}
      onNextCourse={() => void nextCourse()}
      onPrebill={() => void prebill()}
      onDiscount={() => setDialog({ kind: 'discount' })}
      onSplit={() => setDialog({ kind: 'split' })}
      onPay={() => order && navigate(`/pay/${order.id}`)}
      {...(order && order.type !== 'dine_in' ? { onPark: () => void park() } : {})}
    />
  )

  const parkedOrders = (parked.data ?? []).filter((o) => o.status === 'parked')

  return (
    <div className={ticketSide === 'end' ? 'order order--ticket-end' : 'order'} data-testid="order-pad" data-order-id={order?.id ?? ''}>
      {ticket}
      <div className="order__catalog">
        {barcodeOn && <ScanBar onScan={scan} onCreated={(id) => void addCreated(id)} />}
        {orderId === null && parkedOrders.length > 0 && !order && (
          <Button variant="ghost" onClick={() => setDialog({ kind: 'parked' })} data-testid="open-parked">
            {t('order.parked', { count: parkedOrders.length })}
          </Button>
        )}
        <ProductGrid
          categories={categories}
          products={products}
          activeCategory={category}
          onCategory={setCategory}
          onPick={pick}
          search={search}
          onSearch={setSearch}
          keyStyle={keyStyle}
          showStock={stockOn}
          qty={qty}
          onQty={setQty}
        />
      </div>

      {dialog?.kind === 'weight' && (
        <WeightDialog
          product={dialog.product}
          onCancel={() => setDialog(null)}
          onConfirm={(qtyMilli) => {
            setDialog(null)
            void commit(dialog.product, { qtyMilli })
          }}
        />
      )}
      {dialog?.kind === 'modifiers' && (
        <ModifierDialog
          product={dialog.product}
          onCancel={() => setDialog(null)}
          onConfirm={(result) => {
            setDialog(null)
            void commit(dialog.product, { qtyMilli: dialog.qtyMilli, modifierIds: result.modifierIds, note: result.note })
          }}
        />
      )}
      {dialog?.kind === 'menu' && (
        <MenuDialog
          product={dialog.product}
          menu={dialog.menu}
          onCancel={() => setDialog(null)}
          onConfirm={(menuChoices) => {
            setDialog(null)
            void commit(dialog.product, { qtyMilli: dialog.qtyMilli, menuChoices })
          }}
        />
      )}
      {dialog?.kind === 'line' && order && <LineSheet order={order} line={dialog.line} onClose={() => setDialog(null)} onOrder={setOrder} />}
      {dialog?.kind === 'discount' && order && (
        <DiscountDialog
          title={t('order.discountTicket')}
          current={order.discount}
          onCancel={() => setDialog(null)}
          onApply={async (discount) => {
            const result = await guard((tokens) => invoke('orders.setTicketDiscount', { orderId: order.id, discount, overrideTokenId: firstToken(tokens) }))
            if (result.ok) {
              setOrder(result.value)
              setDialog(null)
            }
          }}
        />
      )}
      {dialog?.kind === 'split' && order && (
        <SplitDialog
          order={order}
          onClose={() => setDialog(null)}
          onSplit={() => {
            setDialog(null)
            void load()
          }}
        />
      )}
      {dialog?.kind === 'parked' && <ParkedDialog orders={parkedOrders} onClose={() => setDialog(null)} />}
    </div>
  )
}
