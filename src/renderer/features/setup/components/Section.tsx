import type { ReactNode } from 'react'
import { Card, cx } from '../../../ui'

/** A titled white card of the wizard (a group of fields, a list). */
export function Section({ title, hint, end, className, children }: { title?: ReactNode; hint?: ReactNode; end?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cx('wiz-section', className)} padding="md">
      {(title || end) && (
        <div className="wiz-section__head">
          <div>
            {title && <h2 className="h3">{title}</h2>}
            {hint && <p className="muted wiz-section__hint">{hint}</p>}
          </div>
          {end}
        </div>
      )}
      {children}
    </Card>
  )
}
