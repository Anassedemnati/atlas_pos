import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, TextField } from '../../ui'

export interface ConfirmTypedProps {
  open: boolean
  title: string
  message: string
  /** The word to type, exactly. */
  word: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** A dangerous action behind a typed word: the confirm button stays off until it is typed exactly. */
export function ConfirmTyped({ open, title, message, word, confirmLabel, busy, onConfirm, onCancel }: ConfirmTypedProps) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (!open) setTyped('')
  }, [open])
  const close = () => {
    setTyped('')
    onCancel()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="lg" onClick={onConfirm} disabled={busy || typed !== word} data-testid="confirm-typed-go">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="modal__message">{message}</p>
        <TextField label={t('bo.confirmTyped.label', { word })} value={typed} onChange={setTyped} autoComplete="off" data-testid="confirm-typed-input" />
      </div>
    </Modal>
  )
}
