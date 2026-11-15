import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'
import { TextField } from './TextField'

export interface Reason {
  id: string
  label: string
}

/** Preset reasons per use: ids are stable, labels come from i18n (`reasons.<id>`). */
const PRESETS = {
  void: ['customerChangedMind', 'mistake', 'wrongItem', 'quality', 'wait'],
  discount: ['customerChangedMind', 'quality', 'wait', 'staffMeal', 'gesture']
} as const

export interface ReasonPickerProps {
  open: boolean
  /** The reason, as text (what is stored with the action), and its id (`other` for free text). */
  onPick: (reason: string, id: string) => void
  onCancel: () => void
  title?: string
  /** Preset list for a use, unless `reasons` is given. */
  kind?: keyof typeof PRESETS
  reasons?: Reason[]
  /** Offers "Autre motif" with a text field (default true). */
  allowOther?: boolean
}

/** Why was a line voided, a ticket cancelled, a discount given? One tap, or free text under "Autre motif". */
export function ReasonPicker({ open, onPick, onCancel, title, kind = 'void', reasons, allowOther = true }: ReasonPickerProps) {
  const { t } = useTranslation()
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => {
    if (!open) {
      setOther(false)
      setText('')
    }
  }, [open])

  const list: Reason[] = reasons ?? PRESETS[kind].map((id) => ({ id, label: t(`reasons.${id}`) }))
  const custom = text.trim()

  return (
    <Modal open={open} onClose={onCancel} title={title ?? t('reasons.title')} size="md">
      {other ? (
        <div className="stack">
          <TextField label={t('reasons.otherLabel')} value={text} onChange={setText} maxLength={200} autoFocus onEnter={() => custom && onPick(custom, 'other')} />
          <div className="modal__actions">
            <Button variant="secondary" size="lg" onClick={() => setOther(false)}>
              {t('common.back')}
            </Button>
            <Button size="lg" disabled={!custom} onClick={() => onPick(custom, 'other')}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="reasons">
          <p className="muted">{t('reasons.hint')}</p>
          <div className="reasons__list">
            {list.map((reason) => (
              <Button key={reason.id} variant="secondary" size="lg" block onClick={() => onPick(reason.label, reason.id)}>
                {reason.label}
              </Button>
            ))}
            {allowOther && (
              <Button variant="ghost" size="lg" block onClick={() => setOther(true)}>
                {t('reasons.other')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
