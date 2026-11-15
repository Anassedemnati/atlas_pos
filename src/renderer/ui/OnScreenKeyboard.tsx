import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import { cx } from './metrics'
import { LAYOUTS, type KeyboardLayout } from './keyboardLayouts'

export type { KeyboardLayout } from './keyboardLayouts'

/** `onKey` receives a character (or two, for the Arabic lam-alef), `' '` for space, or one of these names. */
export const KEY_BACKSPACE = 'Backspace'
export const KEY_ENTER = 'Enter'

export interface OnScreenKeyboardProps {
  layout: KeyboardLayout
  onKey: (key: string) => void
  /** Adds a key that hides the keyboard. */
  onHide?: () => void
  className?: string
}

/**
 * A touch keyboard: digits row, three letter rows, one row for space and punctuation. A globe key switches
 * between the starting layout and the other script (Arabic <-> Latin). Keys never take the focus from the
 * field. Always left-to-right as a block (the keys sit where a physical keyboard has them); Arabic rows
 * run right to left inside it.
 */
export function OnScreenKeyboard({ layout, onKey, onHide, className }: OnScreenKeyboardProps) {
  const { t } = useTranslation()
  const [active, setActive] = useState<KeyboardLayout>(layout)
  const [shift, setShift] = useState(false)
  useEffect(() => setActive(layout), [layout])

  const spec = LAYOUTS[active]
  const other: KeyboardLayout = active === 'arabic' ? (layout === 'arabic' ? 'azerty' : layout) : 'arabic'
  const dir = active === 'arabic' ? 'rtl' : 'ltr'

  const type = (key: string) => {
    onKey(shift ? key.toUpperCase() : key)
    if (shift) setShift(false)
  }

  const letter = (key: string) => (
    <Key key={key} onPress={() => type(key)}>
      {shift ? key.toUpperCase() : key}
    </Key>
  )

  return (
    <div className={cx('osk', className)} dir="ltr" role="group" aria-label={t('keyboard.label')}>
      <div className="osk__row" dir="ltr">
        {spec.digits.map((key) => (
          <Key key={key} onPress={() => onKey(key)}>
            {key}
          </Key>
        ))}
      </div>
      {spec.rows.map((row, index) => {
        const last = index === spec.rows.length - 1
        return (
          <div className="osk__row" dir={dir} key={index}>
            {last && spec.shift && (
              <Key className="osk__key--special osk__key--wide" pressed={shift} label={t('keyboard.shift')} onPress={() => setShift(!shift)}>
                <Icon name="shift" size={28} />
              </Key>
            )}
            {row.map(letter)}
            {last && (
              <Key className="osk__key--special osk__key--wide" label={t('keyboard.backspace')} onPress={() => onKey(KEY_BACKSPACE)}>
                <Icon name="backspace" size={28} />
              </Key>
            )}
          </div>
        )
      })}
      <div className="osk__row" dir="ltr">
        <Key
          className="osk__key--special"
          label={t('keyboard.layout')}
          onPress={() => {
            setActive(other)
            setShift(false)
          }}
        >
          <Icon name="globe" size={28} />
        </Key>
        {spec.punctuation.before.map((key) => (
          <Key key={key} onPress={() => onKey(key)}>
            {key}
          </Key>
        ))}
        <Key className="osk__key--space" label={t('keyboard.space')} onPress={() => onKey(' ')}>
          {''}
        </Key>
        {spec.punctuation.after.map((key) => (
          <Key key={key} onPress={() => onKey(key)}>
            {key}
          </Key>
        ))}
        <Key className="osk__key--enter osk__key--wide" label={t('keyboard.enter')} onPress={() => onKey(KEY_ENTER)}>
          <Icon name="enter" size={28} />
        </Key>
        {onHide && (
          <Key className="osk__key--special" label={t('keyboard.hide')} onPress={onHide}>
            <Icon name="chevron" size={28} />
          </Key>
        )}
      </div>
    </div>
  )
}

interface KeyProps {
  onPress: () => void
  className?: string
  label?: string
  pressed?: boolean
  children: ReactNode
}

function Key({ onPress, className, label, pressed, children }: KeyProps) {
  return (
    <button
      type="button"
      className={cx('osk__key', className)}
      onClick={onPress}
      onMouseDown={(event) => event.preventDefault()}
      aria-label={label}
      aria-pressed={pressed}
    >
      {children}
    </button>
  )
}
