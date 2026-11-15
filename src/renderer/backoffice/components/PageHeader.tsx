import type { ReactNode } from 'react'

/** The title of a page, and its actions at the end (search, import, "Nouveau produit"). */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="bo-page-header">
      <h1>{title}</h1>
      {children && <div className="bo-page-header__actions">{children}</div>}
    </header>
  )
}
