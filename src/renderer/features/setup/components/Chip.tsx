import type { ReactNode } from 'react'
import { cx } from '../../../ui'

export interface ChipProps {
  selected: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}

/** A pressable choice that stays on the page (a VAT rate, a printer for a category): selected = teal. */
export function Chip({ selected, onClick, disabled, children }: ChipProps) {
  return (
    <button type="button" className={cx('wiz-chip', selected && 'wiz-chip--on')} aria-pressed={selected} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}
