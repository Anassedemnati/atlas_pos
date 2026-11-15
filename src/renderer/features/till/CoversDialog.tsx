import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Keypad, Modal } from '../../ui'

export interface CoversDialogProps {
  title: string
  /** A line under the title (the seats of a table). */
  hint?: string
  enterLabel: string
  onCancel: () => void
  onConfirm: (covers: number) => void
}

/** The number of guests: a few quick values and a keypad. */
export function CoversDialog({ title, hint, enterLabel, onCancel, onConfirm }: CoversDialogProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const covers = text === '' ? 0 : Number(text)
  return (
    <Modal open onClose={onCancel} title={title} size="sm">
      <div className="stack" style={{ alignItems: 'center' }} data-testid="covers-dialog">
        {hint && <p className="muted">{hint}</p>}
        <div className="cluster" aria-label={t('floor.coversTitle')}>
          {[1, 2, 3, 4, 6].map((n) => (
            <Button key={n} variant="secondary" onClick={() => onConfirm(n)} data-testid={`covers-${n}`}>
              {n}
            </Button>
          ))}
        </div>
        <Keypad mode="qty" value={text} onChange={(v) => setText(v.replace(/[^0-9]/g, ''))} onEnter={() => onConfirm(covers)} enterLabel={enterLabel} maxLength={3} minLength={1} />
      </div>
    </Modal>
  )
}
