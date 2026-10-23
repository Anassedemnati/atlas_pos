import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../ui'

export interface SortableItem {
  id: string
  content: ReactNode
}

const move = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * A list that is reordered by dragging a row, or with the up / down buttons (a keyboard and a touch screen have no drag).
 * `onReorder` gets the ids in their new order.
 */
export function SortableList({ items, onReorder, testId }: { items: SortableItem[]; onReorder: (ids: string[]) => void; testId?: string }) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const ids = items.map((item) => item.id)

  const drop = (to: number) => {
    if (dragging !== null && dragging !== to) onReorder(move(ids, dragging, to))
    setDragging(null)
    setOver(null)
  }

  return (
    <ul className="bo-sortable" data-testid={testId}>
      {items.map((item, index) => (
        <li
          key={item.id}
          className={`bo-sortable__row${over === index && dragging !== null && dragging !== index ? ' bo-sortable__row--over' : ''}`}
          draggable
          data-testid={`sortable-${item.id}`}
          onDragStart={(event) => {
            setDragging(index)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', item.id)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(index)
          }}
          onDrop={(event) => {
            event.preventDefault()
            drop(index)
          }}
          onDragEnd={() => {
            setDragging(null)
            setOver(null)
          }}
        >
          <span className="bo-sortable__handle" aria-hidden="true">
            <Icon name="split" size={22} />
          </span>
          <div className="bo-sortable__content">{item.content}</div>
          <button type="button" className="bo-iconbtn" aria-label={t('bo.keyboards.up')} disabled={index === 0} onClick={() => onReorder(move(ids, index, index - 1))} data-testid={`up-${item.id}`}>
            <Icon name="chevron" size={22} className="bo-flip" />
          </button>
          <button type="button" className="bo-iconbtn" aria-label={t('bo.keyboards.down')} disabled={index === items.length - 1} onClick={() => onReorder(move(ids, index, index + 1))} data-testid={`down-${item.id}`}>
            <Icon name="chevron" size={22} />
          </button>
        </li>
      ))}
    </ul>
  )
}
