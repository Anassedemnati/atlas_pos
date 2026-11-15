import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'

export interface EmptyStateProps {
  icon?: IconName
  title: ReactNode
  hint?: ReactNode
  /** Usually a Button. */
  action?: ReactNode
  className?: string
}

/** What a list or a screen shows when there is nothing to show yet ("Sélectionnez une table"). */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cx('empty', className)}>
      {icon && (
        <span className="empty__icon">
          <Icon name={icon} size={56} />
        </span>
      )}
      <p className="h3">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  )
}
