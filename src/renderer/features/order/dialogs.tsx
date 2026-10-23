import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuDto, ModifierGroupDto, ProductDto } from '@shared/dto'
import { Button, Icon, Keypad, Modal, TextField } from '../../ui'
import { cx } from '../../ui/metrics'
import { formatQty, parseQty, useFormat } from '../till/format'
import { useTill } from '../till/store'

/** A chip that is on or off (a modifier, a menu item). */
function Choice({ on, children, onClick, testId }: { on: boolean; children: React.ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button type="button" className={cx('choice', on && 'choice--on')} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {on && <Icon name="check" size={22} strokeWidth={3} />}
      {children}
    </button>
  )
}

export interface ModifierResult {
  modifierIds: string[]
  note: string
}

/** The options of a product, group by group; each group's minimum and maximum are enforced before "Ajouter". */
export function ModifierDialog({ product, onCancel, onConfirm }: { product: ProductDto; onCancel: () => void; onConfirm: (result: ModifierResult) => void }) {
  const { t } = useTranslation()
  const { catalog } = useTill()
  const { name, money } = useFormat()
  const groups: ModifierGroupDto[] = product.modifierGroupIds.map((id) => catalog.modifierGroups.find((g) => g.id === id)).filter((g): g is ModifierGroupDto => !!g)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [note, setNote] = useState('')

  const toggle = (group: ModifierGroupDto, id: string) =>
    setPicked((current) => {
      const now = current[group.id] ?? []
      if (now.includes(id)) return { ...current, [group.id]: now.filter((x) => x !== id) }
      // A single-choice group swaps its choice; a multiple one stops at its maximum.
      if (group.maxSelect === 1) return { ...current, [group.id]: [id] }
      if (group.maxSelect > 0 && now.length >= group.maxSelect) return current
      return { ...current, [group.id]: [...now, id] }
    })
  const invalid = groups.find((g) => (picked[g.id]?.length ?? 0) < g.minSelect)

  return (
    <Modal
      open
      onClose={onCancel}
      title={name(product.name)}
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" disabled={!!invalid} onClick={() => onConfirm({ modifierIds: groups.flatMap((g) => picked[g.id] ?? []), note: note.trim() })} data-testid="modifiers-confirm">
            {t('order.add')}
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="modifier-dialog">
        {groups.map((group) => (
          <section key={group.id}>
            <h3 className="h3">
              {name(group.name)}{' '}
              <small className="muted">
                {group.minSelect > 0 ? t('order.required') : t('order.optional')}
                {group.maxSelect > 1 ? ` · ${t('order.upTo', { count: group.maxSelect })}` : ''}
              </small>
            </h3>
            <div className="choices">
              {group.modifiers.map((m) => (
                <Choice key={m.id} on={(picked[group.id] ?? []).includes(m.id)} onClick={() => toggle(group, m.id)} testId={`modifier-${m.id}`}>
                  {name(m.name)}
                  {m.priceDeltaCents !== 0 && <small> {m.priceDeltaCents > 0 ? '+' : ''}{money(m.priceDeltaCents)}</small>}
                </Choice>
              ))}
            </div>
          </section>
        ))}
        <TextField label={t('order.note')} value={note} onChange={setNote} maxLength={200} />
      </div>
    </Modal>
  )
}

/** A set menu: choose the dishes of each course. */
export function MenuDialog({ product, menu, onCancel, onConfirm }: { product: ProductDto; menu: MenuDto; onCancel: () => void; onConfirm: (choices: { courseId: string; productIds: string[] }[]) => void }) {
  const { t } = useTranslation()
  const { catalog } = useTill()
  const { name, money } = useFormat()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const productName = (id: string) => {
    const p = catalog.products.find((x) => x.id === id)
    return p ? name(p.name) : id
  }
  const toggle = (courseId: string, count: number, id: string) =>
    setPicked((current) => {
      const now = current[courseId] ?? []
      if (now.includes(id)) return { ...current, [courseId]: now.filter((x) => x !== id) }
      if (count === 1) return { ...current, [courseId]: [id] }
      if (now.length >= count) return current
      return { ...current, [courseId]: [...now, id] }
    })
  const complete = menu.courses.every((c) => (picked[c.id]?.length ?? 0) === Math.max(1, c.chooseCount))
  return (
    <Modal
      open
      onClose={onCancel}
      title={name(product.name)}
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" disabled={!complete} onClick={() => onConfirm(menu.courses.map((c) => ({ courseId: c.id, productIds: picked[c.id] ?? [] })))} data-testid="menu-confirm">
            {t('order.add')}
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="menu-dialog">
        {menu.courses.map((course) => (
          <section key={course.id}>
            <h3 className="h3">
              {name(course.name)} <small className="muted">{t('order.chooseCount', { count: Math.max(1, course.chooseCount) })}</small>
            </h3>
            <div className="choices">
              {course.items.map((item) => (
                <Choice key={item.productId} on={(picked[course.id] ?? []).includes(item.productId)} onClick={() => toggle(course.id, Math.max(1, course.chooseCount), item.productId)} testId={`menu-item-${item.productId}`}>
                  {productName(item.productId)}
                  {item.supplementCents !== 0 && <small> +{money(item.supplementCents)}</small>}
                </Choice>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}

/** The weight of an item sold by weight, typed in kilograms ("0,350 kg"), with the price it comes to. */
export function WeightDialog({ product, initial, onCancel, onConfirm }: { product: ProductDto; initial?: number; onCancel: () => void; onConfirm: (qtyMilli: number) => void }) {
  const { t } = useTranslation()
  const { name, money } = useFormat()
  const [text, setText] = useState(initial ? formatQty(initial) : '')
  const qty = parseQty(text)
  const total = qty === null ? 0 : Math.round((product.priceCents * qty) / 1000)
  return (
    <Modal open onClose={onCancel} title={name(product.name)} size="sm">
      <div className="stack" style={{ alignItems: 'center' }} data-testid="weight-dialog">
        <p className="muted">
          {money(product.priceCents)} / kg
        </p>
        <Keypad
          mode="qty"
          value={text}
          onChange={setText}
          onEnter={(value) => {
            const parsed = parseQty(value)
            if (parsed && parsed > 0) onConfirm(parsed)
          }}
          enterLabel={t('order.add')}
          maxLength={7}
          captureKeys
        />
        <p className="h2 figure" data-testid="weight-total">
          {qty === null ? '0,000' : formatQty(qty, true).replace(' kg', '')} kg · {money(total)}
        </p>
      </div>
    </Modal>
  )
}

/** A quantity typed on the keypad (an item count, or kilograms for an item sold by weight). */
export function QtyDialog({ title, initial, byWeight, onCancel, onConfirm }: { title: string; initial: number; byWeight: boolean; onCancel: () => void; onConfirm: (qtyMilli: number) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  return (
    <Modal open onClose={onCancel} title={title} size="sm">
      <div className="stack" style={{ alignItems: 'center' }} data-testid="qty-dialog">
        <p className="muted">{t('order.currentQty', { qty: formatQty(initial, byWeight) })}</p>
        <Keypad
          mode="qty"
          value={text}
          onChange={setText}
          onEnter={(value) => {
            const parsed = parseQty(value)
            if (parsed && parsed > 0) onConfirm(parsed)
          }}
          enterLabel={t('common.confirm')}
          maxLength={7}
          captureKeys
        />
      </div>
    </Modal>
  )
}
