import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TableDto } from '@shared/dto'
import type { OrderSummaryDto } from '@shared/ipc/till'
import { invoke, useApi } from '../../app/api'
import { navigate } from '../../app/router'
import { Button, Modal } from '../../ui'
import { useGuard, firstToken } from '../till/Override'
import { useFormat } from '../till/format'
import { useTill } from '../till/store'

export interface TableDialogProps {
  table: TableDto
  order: OrderSummaryDto
  orders: OrderSummaryDto[]
  onClose: () => void
}

/** The long press on an occupied table: open it, move it to a free table, or merge it into another table's order. */
export function TableDialog({ table, order, orders, onClose }: TableDialogProps) {
  const { t } = useTranslation()
  const api = useApi()
  const { guard } = useGuard()
  const { floor } = useTill()
  const { tableName } = useFormat()
  const [mode, setMode] = useState<'menu' | 'transfer' | 'merge'>('menu')
  const busyTables = new Set(orders.filter((o) => o.tableId).map((o) => o.tableId))
  const free = floor.tables.filter((tb) => tb.active && !busyTables.has(tb.id))
  const others = orders.filter((o) => o.tableId && o.id !== order.id)

  const transfer = async (to: TableDto) => {
    const result = await api.call('orders.transferTable', { orderId: order.id, toTableId: to.id })
    if (result.ok) onClose()
  }
  const merge = async (into: OrderSummaryDto) => {
    const result = await guard((tokens) => invoke('orders.mergeTables', { fromOrderId: order.id, intoOrderId: into.id, overrideTokenId: firstToken(tokens) }))
    if (result.ok) onClose()
  }

  return (
    <Modal open onClose={onClose} title={tableName(table.label)} size="md">
      <div className="stack" data-testid="table-dialog">
        {mode === 'menu' && (
          <>
            <Button size="lg" block onClick={() => navigate(`/order/${order.id}`)}>
              {t('floor.openTable')}
            </Button>
            <Button size="lg" variant="secondary" block onClick={() => setMode('transfer')} data-testid="table-transfer">
              {t('floor.transfer')}
            </Button>
            <Button size="lg" variant="secondary" block onClick={() => setMode('merge')} disabled={others.length === 0} data-testid="table-merge">
              {t('floor.merge')}
            </Button>
          </>
        )}
        {mode === 'transfer' && (
          <>
            <p className="muted">{t('floor.transferTo')}</p>
            <div className="pick-grid">
              {free.map((tb) => (
                <Button key={tb.id} variant="secondary" size="lg" onClick={() => void transfer(tb)} data-testid={`transfer-to-${tb.label}`}>
                  {tableName(tb.label)}
                </Button>
              ))}
            </div>
            {free.length === 0 && <p className="muted">{t('floor.noFreeTable')}</p>}
          </>
        )}
        {mode === 'merge' && (
          <>
            <p className="muted">{t('floor.mergeInto')}</p>
            <div className="pick-grid">
              {others.map((o) => (
                <Button key={o.id} variant="secondary" size="lg" onClick={() => void merge(o)} data-testid={`merge-into-${o.tableLabel}`}>
                  {tableName(o.tableLabel ?? '')}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
