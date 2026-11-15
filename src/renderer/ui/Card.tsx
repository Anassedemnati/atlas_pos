import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './metrics'

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'onClick'> {
  /** Highlighted as the chosen one (teal outline and tint). */
  selected?: boolean
  /** Makes the whole card a button. */
  onClick?: () => void
  /** Inner padding; `none` for cards that hold a list or an image. */
  padding?: 'none' | 'md' | 'lg'
  disabled?: boolean
  children?: ReactNode
}

/** A white card, 14 px radius, soft shadow. With `onClick` it is one big touch button. */
export function Card({ selected, onClick, padding = 'md', disabled, className, children, ...rest }: CardProps) {
  const classes = cx('card', `card--pad-${padding}`, selected && 'card--selected', onClick && 'card--action', className)
  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        disabled={disabled}
        aria-pressed={selected === undefined ? undefined : selected}
        {...(rest as HTMLAttributes<HTMLButtonElement>)}
      >
        {children}
      </button>
    )
  }
  return (
    <div className={classes} {...(rest as HTMLAttributes<HTMLDivElement>)}>
      {children}
    </div>
  )
}
