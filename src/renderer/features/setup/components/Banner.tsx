import type { ReactNode } from 'react'
import { Icon, cx } from '../../../ui'

/** A notice inside a step: `warning` (amber) for what must be checked, `info` for the rest. */
export function Banner({ tone = 'warning', children }: { tone?: 'warning' | 'info'; children: ReactNode }) {
  return (
    <div className={cx('wiz-banner', `wiz-banner--${tone}`)} role="status">
      <Icon name={tone === 'warning' ? 'warning' : 'lightning'} size={28} />
      <div>{children}</div>
    </div>
  )
}
