import type { CSSProperties, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'

export interface TabItem<Id extends string = string> {
  id: Id
  label: ReactNode
  icon?: IconName
  /** A tint for this tab (categories on the order pad): any CSS colour. */
  color?: string
  /** A count or a dot. */
  badge?: ReactNode
}

export interface TabsProps<Id extends string = string> {
  tabs: TabItem<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** `segmented`: chips on the page; `bar`: light-on-navy, for the top bar; `underline`: a sub-navigation. */
  variant?: 'segmented' | 'bar' | 'underline'
  className?: string
  'aria-label'?: string
}

export function Tabs<Id extends string = string>({ tabs, value, onChange, variant = 'segmented', className, ...rest }: TabsProps<Id>) {
  return (
    <div role="tablist" className={cx('tabs', `tabs--${variant}`, className)} aria-label={rest['aria-label']}>
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cx('tab', selected && 'tab--selected', tab.color && 'tab--tinted')}
            style={tab.color ? ({ '--tab-color': tab.color } as CSSProperties) : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon && <Icon name={tab.icon} size={24} />}
            <span>{tab.label}</span>
            {tab.badge !== undefined && <span className="tab__badge">{tab.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}
