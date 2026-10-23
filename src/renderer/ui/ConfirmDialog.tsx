import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  open: boolean
  title?: ReactNode
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` for a destructive action (red confirm button). */
  tone?: 'primary' | 'danger'
  /** The confirm button is waiting for an answer. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** "Are you sure?": a question and two big buttons. The safe one is Cancel, on the start side. */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, tone = 'primary', busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={title ?? t('confirm.title')}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="lg" onClick={onConfirm} disabled={busy}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {message && <p className="modal__message">{message}</p>}
    </Modal>
  )
}
