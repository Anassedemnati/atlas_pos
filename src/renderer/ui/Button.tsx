import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx, type ControlSize } from './metrics'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: teal fill (the one main action); secondary: grey fill; ghost: teal outline; danger: red fill. */
  variant?: ButtonVariant
  /** Heights 64 / 72 / 88 px. The main action of a screen is `lg` or `xl`. */
  size?: ControlSize
  icon?: IconName
  /** Icon after the label (an arrow, for "Suivant"). */
  iconEnd?: IconName
  /** Fills the width of its container. */
  block?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconEnd,
  block,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', className)}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'xl' ? 32 : 26} />}
      {children !== undefined && <span className="btn__label">{children}</span>}
      {iconEnd && <Icon name={iconEnd} size={size === 'xl' ? 32 : 26} />}
    </button>
  )
}
