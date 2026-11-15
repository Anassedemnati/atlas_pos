import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'

export type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'teal'

export interface PillProps {
  tone?: PillTone
  /** A coloured dot before the text (a status light). */
  dot?: boolean
  icon?: IconName
  /** For use on the navy top bar. */
  onDark?: boolean
  className?: string
  children?: ReactNode
}

/** A small status label: "Connectée", "Non détecté", "Sauvegarde OK". Information only, not a target. */
export function Pill({ tone = 'neutral', dot, icon, onDark, className, children }: PillProps) {
  return (
    <span className={cx('pill', `pill--${tone}`, onDark && 'pill--on-dark', className)}>
      {dot && <span className="pill__dot" aria-hidden="true" />}
      {icon && <Icon name={icon} size={18} />}
      {children}
    </span>
  )
}
