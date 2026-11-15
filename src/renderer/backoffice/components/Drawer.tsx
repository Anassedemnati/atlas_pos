import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../ui'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children?: ReactNode
  /** The buttons row at the bottom (Annuler, Enregistrer). */
  footer?: ReactNode
  testId?: string
}

/** A panel sliding in from the end side (right in French, left in Arabic) over a dimmed page. Escape closes it. */
export function Drawer({ open, onClose, title, children, footer, testId }: DrawerProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => before?.focus?.()
  }, [open])

  if (!open) return null
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }
  return createPortal(
    <div className="bo-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="bo-drawer" data-testid={testId} onKeyDown={onKeyDown}>
        <header className="bo-drawer__header">
          <h2 id={titleId} className="h3">
            {title}
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" size={28} />
          </button>
        </header>
        <div className="bo-drawer__body">{children}</div>
        {footer && <footer className="bo-drawer__footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}
