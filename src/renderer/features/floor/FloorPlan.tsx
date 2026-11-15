import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { TableDto } from '@shared/dto'
import type { OrderSummaryDto } from '@shared/ipc/till'
import { useApi, useQuery } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, Icon, Tabs, type TabItem } from '../../ui'
import { useFormat, minutesSince } from '../till/format'
import { CoversDialog } from '../till/CoversDialog'
import { TillLayout } from '../till/TillLayout'
import { can, moduleOn, useTill } from '../till/store'
import { FloorEditor } from './FloorEditor'
import { TableDialog } from './TableDialog'
import { useFit } from './useFit'

type View = string

/** Every open or parked order, kept fresh. */
function useOrderList() {
  return useQuery('orders.list', {}, { silent: true, refreshOn: ['order.changed', 'ticket.closed', 'day.closed'] })
}

function FloorTabs({ view: chosen, onChange }: { view: View; onChange: (view: View) => void }) {
  const { t } = useTranslation()
  const { floor } = useTill()
  const view = chosen || defaultView(floor.rooms)
  const { name } = useFormat()
  const tabs: TabItem[] = [
    ...[...floor.rooms].sort((a, b) => a.sort - b.sort).map((room) => ({ id: `room:${room.id}`, label: name(room.name) })),
    { id: 'takeaway', label: t('floor.takeaway') },
    { id: 'delivery', label: t('floor.delivery') }
  ]
  return <Tabs variant="bar" tabs={tabs} value={view} onChange={onChange} aria-label={t('floor.title')} />
}

/** The floor plan of a restaurant (mockup 05): rooms as tabs, tables where they are, takeaway and delivery lists. */
export function FloorPlan() {
  const [view, setView] = useState<View>('')
  const [editing, setEditing] = useState(false)
  return (
    <TillLayout nav={editing ? undefined : <FloorTabs view={view} onChange={setView} />}>
      {editing ? <EditorHost onClose={() => setEditing(false)} /> : <FloorBody view={view} onEdit={() => setEditing(true)} />}
    </TillLayout>
  )
}

/** The editor, told which tables have an order open (those cannot be removed). */
function EditorHost({ onClose }: { onClose: () => void }) {
  const orders = useOrderList()
  const busy = useMemo(() => new Set((orders.data ?? []).flatMap((o) => (o.tableId ? [o.tableId] : []))), [orders.data])
  return <FloorEditor busyTableIds={busy} onClose={onClose} />
}

/** The tab shown first: the first room. */
const defaultView = (rooms: { id: string; sort: number }[]): View => `room:${[...rooms].sort((a, b) => a.sort - b.sort)[0]?.id ?? 'none'}`

function FloorBody({ view: chosen, onEdit }: { view: View; onEdit: () => void }) {
  const { t } = useTranslation()
  const data = useTill()
  const view = chosen || defaultView(data.floor.rooms)
  const orders = useOrderList()
  const list = orders.data ?? []
  return (
    <div className="floor">
      <div className="floor__main">
        {view === 'takeaway' || view === 'delivery' ? (
          <TypeOrders type={view} orders={list.filter((o) => o.type === view)} />
        ) : (
          <Rooms roomId={view.replace('room:', '')} orders={list.filter((o) => o.tableId !== null)} />
        )}
        <nav className="floor__actions">
          <Button size="xl" icon="cart" onClick={() => navigate('/counter')} data-testid="direct-sale">
            {t('floor.directSale')}
          </Button>
          <Button size="xl" variant="secondary" icon="printer" onClick={() => navigate('/tickets')} data-testid="open-tickets">
            {t('floor.tickets')}
          </Button>
          {can(data, 'report.x') && (
            <Button size="xl" variant="secondary" icon="chart" onClick={() => navigate('/closure')} data-testid="open-closure">
              {t('floor.closure')}
            </Button>
          )}
          {can(data, 'settings.manage') && moduleOn(data, 'tables') && (
            <Button size="xl" variant="secondary" icon="gear" onClick={onEdit} data-testid="floor-edit">
              {t('floor.editor.edit')}
            </Button>
          )}
        </nav>
      </div>
      <SidePanel orders={list} />
    </div>
  )
}

function SidePanel({ orders }: { orders: OrderSummaryDto[] }) {
  const { t } = useTranslation()
  const data = useTill()
  const { money } = useFormat()
  const x = useQuery('days.xReport', {}, { silent: true, enabled: can(data, 'report.x'), refreshOn: ['ticket.closed', 'day.closed'] })
  const tables = data.floor.tables.filter((table) => table.active)
  const byTable = new Map(orders.filter((o) => o.tableId).map((o) => [o.tableId!, o]))
  const bill = [...byTable.values()].filter((o) => o.billRequested).length
  const occupied = byTable.size - bill
  return (
    <aside className="floor__side card" data-testid="floor-side">
      <h2 className="h2">{t('floor.today')}</h2>
      {x.data ? (
        <>
          <p className="floor__total figure">{money(x.data.totalCents)}</p>
          <p className="h3 muted">{t('closure.ticketsCount', { count: x.data.ticketsCount })}</p>
        </>
      ) : (
        <p className="h3 muted">{t('floor.openOrders', { count: orders.length })}</p>
      )}
      <ul className="legend">
        <li>
          <span className="legend__dot legend__dot--free" />
          <span className="grow">{t('floor.free')}</span>
          <span className="muted">{t('floor.tablesCount', { count: Math.max(0, tables.length - byTable.size) })}</span>
        </li>
        <li>
          <span className="legend__dot legend__dot--busy" />
          <span className="grow">{t('floor.occupied')}</span>
          <span className="muted">{t('floor.tablesCount', { count: occupied })}</span>
        </li>
        <li>
          <span className="legend__dot legend__dot--bill" />
          <span className="grow">{t('floor.bill')}</span>
          <span className="muted">{t('floor.tablesCount', { count: bill })}</span>
        </li>
      </ul>
      <div className="floor__hint muted">
        <Icon name="table" size={56} />
        <p>{t('floor.hint')}</p>
      </div>
    </aside>
  )
}

function Rooms({ roomId, orders }: { roomId: string; orders: OrderSummaryDto[] }) {
  const { t } = useTranslation()
  const api = useApi()
  const { tableName } = useFormat()
  const { floor } = useTill()
  const [covers, setCovers] = useState<TableDto | null>(null)
  const [actions, setActions] = useState<{ table: TableDto; order: OrderSummaryDto } | null>(null)
  const tables = useMemo(() => floor.tables.filter((table) => table.roomId === roomId && table.active), [floor.tables, roomId])
  const width = Math.max(400, ...tables.map((table) => table.x + table.w + 40))
  const height = Math.max(300, ...tables.map((table) => table.y + table.h + 40))
  const { ref, scale } = useFit(width, height)
  const byTable = new Map(orders.map((o) => [o.tableId, o]))

  const open = async (table: TableDto, count: number) => {
    const result = await api.call('orders.open', { type: 'dine_in', tableId: table.id, covers: count })
    if (result.ok) navigate(`/order/${result.value.id}`)
  }

  return (
    <div className="floor__room" ref={ref}>
      <h1 className="floor__title">{t('floor.title')}</h1>
      <div className="floor__canvas" style={{ inlineSize: width * scale, blockSize: height * scale }} data-testid="floor-canvas">
        {tables.map((table) => (
          <TableTile
            key={table.id}
            table={table}
            order={byTable.get(table.id)}
            scale={scale}
            onTap={() => (byTable.get(table.id) ? navigate(`/order/${byTable.get(table.id)!.id}`) : setCovers(table))}
            onLongPress={() => {
              const order = byTable.get(table.id)
              if (order) setActions({ table, order })
            }}
          />
        ))}
      </div>
      {tables.length === 0 && <p className="muted">{t('floor.noTables')}</p>}
      {covers && (
        <CoversDialog
          title={`${tableName(covers.label)} · ${t('floor.coversTitle')}`}
          hint={t('floor.seats', { count: covers.seats })}
          enterLabel={t('floor.open')}
          onCancel={() => setCovers(null)}
          onConfirm={(count) => void open(covers, count)}
        />
      )}
      {actions && <TableDialog table={actions.table} order={actions.order} orders={orders} onClose={() => setActions(null)} />}
    </div>
  )
}

function TableTile({
  table,
  order,
  scale,
  onTap,
  onLongPress
}: {
  table: TableDto
  order: OrderSummaryDto | undefined
  scale: number
  onTap: () => void
  onLongPress: () => void
}) {
  const { t } = useTranslation()
  const { money, tableName } = useFormat()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const state = !order ? 'free' : order.billRequested ? 'bill' : 'busy'
  const style: CSSProperties = { insetInlineStart: table.x * scale, insetBlockStart: table.y * scale, inlineSize: table.w * scale, blockSize: table.h * scale }
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return (
    <button
      type="button"
      className={`table-tile table-tile--${state} table-tile--${table.shape}`}
      style={style}
      data-testid={`table-${table.label}`}
      data-state={state}
      onPointerDown={() => {
        fired.current = false
        clear()
        timer.current = setTimeout(() => {
          fired.current = true
          onLongPress()
        }, 650)
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (fired.current) {
          fired.current = false
          return
        }
        onTap()
      }}
    >
      <span className="table-tile__label">{tableName(table.label)}</span>
      {order && (
        <>
          <span className="table-tile__meta">{state === 'bill' ? t('floor.billShort') : t('floor.covers', { count: order.covers })}</span>
          <span className="table-tile__meta">
            <Icon name="lightning" size={16} /> {t('floor.minutes', { count: minutesSince(order.openedAt) })}
          </span>
          <span className="table-tile__amount figure">{money(order.totalCents)}</span>
        </>
      )}
    </button>
  )
}

function TypeOrders({ type, orders }: { type: string; orders: OrderSummaryDto[] }) {
  const { t } = useTranslation()
  const api = useApi()
  const { money, orderTitle } = useFormat()
  const create = async () => {
    const result = await api.call('orders.open', { type: type as 'takeaway' | 'delivery' })
    if (result.ok) navigate(`/order/${result.value.id}`)
  }
  return (
    <div className="floor__room">
      <div className="floor__head">
        <h1 className="floor__title">{type === 'takeaway' ? t('floor.takeaway') : t('floor.delivery')}</h1>
        <Button size="lg" icon="plus" onClick={() => void create()} data-testid="new-type-order">
          {t('floor.newOrder')}
        </Button>
      </div>
      {orders.length === 0 ? (
        <p className="muted">{t('floor.noOrders')}</p>
      ) : (
        <ul className="plain-list" data-testid="type-orders">
          {orders.map((order) => (
            <li key={order.id}>
              <button type="button" className="order-row" onClick={() => navigate(`/order/${order.id}`)}>
                <strong className="grow">{orderTitle(order)}</strong>
                <span className="muted">{t('floor.minutes', { count: minutesSince(order.openedAt) })}</span>
                {order.status === 'parked' && <span className="chip chip--wait">{t('floor.parked')}</span>}
                <strong className="figure">{money(order.totalCents)}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
