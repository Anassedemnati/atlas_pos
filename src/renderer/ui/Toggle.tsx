import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The text beside the switch; it is also the accessible name. */
  label: ReactNode
  icon?: IconName
  disabled?: boolean
  className?: string
}

/** An on/off switch (`role="switch"`) on a 64 px row: the whole row is the touch target. */
export function Toggle({ checked, onChange, label, icon, disabled, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('toggle', checked && 'toggle--on', className)}
      onClick={() => onChange(!checked)}
    >
      {icon && <Icon name={icon} size={30} />}
      <span className="toggle__label">{label}</span>
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__knob" />
      </span>
    </button>
  )
}
