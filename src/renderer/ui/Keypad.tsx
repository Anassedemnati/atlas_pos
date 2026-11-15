import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import { cx } from './metrics'

export type KeypadMode = 'pin' | 'qty' | 'money'

/** The decimal separator keys produce (French style, like `formatMoney`). */
export const DECIMAL = ','

const LIMITS: Record<KeypadMode, { maxLength: number; minLength: number; decimals: number }> = {
  pin: { maxLength: 6, minLength: 4, decimals: 0 },
  qty: { maxLength: 8, minLength: 1, decimals: 3 },
  money: { maxLength: 10, minLength: 1, decimals: 2 }
}

/**
 * The text a keypad holds after a key: digits append, `,` starts the decimals (at most once, with the
 * mode's number of decimals), `00` appends two zeros, `Backspace` removes the last character.
 * A PIN is digits only. Pure, so every screen that types an amount behaves the same.
 */
export function applyKey(value: string, key: string, mode: KeypadMode, maxLength: number = LIMITS[mode].maxLength): string {
  if (key === 'Backspace') return value.slice(0, -1)
  if (key === '00') return applyKey(applyKey(value, '0', mode, maxLength), '0', mode, maxLength)
  if (key === DECIMAL) {
    if (mode === 'pin' || value.includes(DECIMAL) || LIMITS[mode].decimals === 0) return value
    const next = value === '' ? `0${DECIMAL}` : value + DECIMAL
    return next.length <= maxLength ? next : value
  }
  if (!/^\d+$/.test(key)) return value
  // Typing over a lone zero replaces it ("0" then "5" is "5"), except in a PIN, where 0 is a digit.
  const base = mode !== 'pin' && value === '0' ? '' : value
  const next = base + key
  if (next.length > maxLength) return value
  const at = next.indexOf(DECIMAL)
  if (at >= 0 && next.length - at - 1 > LIMITS[mode].decimals) return value
  return next
}

export interface KeypadProps {
  /** `pin`: masked, 4 to 6 digits; `qty`: up to 3 decimals; `money`: up to 2 decimals and a `00` key. */
  mode: KeypadMode
  /** Controlled text. Without it the keypad keeps its own. */
  value?: string
  onChange?: (value: string) => void
  /** Every digit key pressed (a digit, `,` or `00`); Backspace goes to `onBackspace`. */
  onDigit?: (key: string) => void
  onBackspace?: () => void
  /** The validate key, with the text typed. Disabled until the text is long enough (4 digits for a PIN). */
  onEnter?: (value: string) => void
  maxLength?: number
  minLength?: number
  /** No display above the keys (a field shows the text instead). */
  hideDisplay?: boolean
  enterLabel?: string
  /** Also reads the physical keyboard (digits, comma, Backspace, Enter), for a till with a keyboard. */
  captureKeys?: boolean
  disabled?: boolean
  /** Marks the display as wrong (a refused PIN). */
  invalid?: boolean
  className?: string
  'aria-label'?: string
}

export function Keypad({
  mode,
  value,
  onChange,
  onDigit,
  onBackspace,
  onEnter,
  maxLength,
  minLength,
  hideDisplay,
  enterLabel,
  captureKeys,
  disabled,
  invalid,
  className,
  ...rest
}: KeypadProps) {
  const { t } = useTranslation()
  const [own, setOwn] = useState('')
  const text = value ?? own
  const max = maxLength ?? LIMITS[mode].maxLength
  const min = minLength ?? LIMITS[mode].minLength

  // Handlers read the latest text through a ref so a burst of taps never works from a stale value.
  const latest = useRef(text)
  latest.current = text

  const press = useCallback(
    (key: string) => {
      if (disabled) return
      if (key === 'Backspace') onBackspace?.()
      else onDigit?.(key)
      const next = applyKey(latest.current, key, mode, max)
      latest.current = next
      setOwn(next)
      onChange?.(next)
    },
    [disabled, mode, max, onBackspace, onChange, onDigit]
  )

  const enter = useCallback(() => {
    if (!disabled && latest.current.length >= min && latest.current.length > 0) onEnter?.(latest.current)
  }, [disabled, min, onEnter])

  useEffect(() => {
    if (!captureKeys) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (/^\d$/.test(event.key)) press(event.key)
      else if (event.key === ',' || event.key === '.') press(DECIMAL)
      else if (event.key === 'Backspace') press('Backspace')
      else if (event.key === 'Enter') enter()
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [captureKeys, press, enter])

  const key = (label: string, extra?: string) => (
    <KeyButton key={label} onPress={() => press(label)} disabled={disabled} className={extra}>
      {label}
    </KeyButton>
  )
  const backspace = (extra?: string) => (
    <KeyButton onPress={() => press('Backspace')} disabled={disabled} className={cx('keypad__key--muted', extra)} label={t('keypad.backspace')}>
      <Icon name="backspace" size={30} />
    </KeyButton>
  )
  const enterKey = (wide: boolean) => (
    <KeyButton
      onPress={enter}
      disabled={disabled || text.length < Math.max(min, 1)}
      className={cx('keypad__key--enter', wide && 'keypad__key--wide')}
      label={enterLabel ?? t('keypad.enter')}
    >
      {wide ? <span>{enterLabel ?? t('keypad.enter')}</span> : <Icon name="check" size={34} strokeWidth={3} />}
    </KeyButton>
  )

  return (
    <div className={cx('keypad', `keypad--${mode}`, className)} dir="ltr" role="group" aria-label={rest['aria-label']}>
      {!hideDisplay && (
        <div
          className={cx('keypad__display', invalid && 'keypad__display--invalid')}
          role="status"
          aria-label={mode === 'pin' ? t('keypad.pinValue', { count: text.length }) : text || t('keypad.empty')}
          data-testid="keypad-display"
        >
          {mode === 'pin'
            ? Array.from({ length: max }, (_, index) => (
                <span key={index} className={cx('keypad__dot', index < text.length && 'keypad__dot--filled')}>
                  {index < text.length ? '•' : ''}
                </span>
              ))
            : text || <span className="keypad__placeholder">0</span>}
        </div>
      )}
      <div className="keypad__grid">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => key(digit))}
        {mode === 'pin' && (
          <>
            {backspace()}
            {key('0')}
            {enterKey(false)}
          </>
        )}
        {mode === 'qty' && (
          <>
            {key(DECIMAL)}
            {key('0')}
            {backspace()}
            {enterKey(true)}
          </>
        )}
        {mode === 'money' && (
          <>
            {key(DECIMAL)}
            {key('0')}
            {key('00')}
            {backspace()}
            {enterKey(true)}
          </>
        )}
      </div>
    </div>
  )
}

interface KeyButtonProps {
  onPress: () => void
  disabled?: boolean
  className?: string
  label?: string
  children: ReactNode
}

function KeyButton({ onPress, disabled, className, label, children }: KeyButtonProps) {
  return (
    <button
      type="button"
      className={cx('keypad__key', className)}
      onClick={onPress}
      // Keys never take the focus from the field being typed in.
      onMouseDown={(event) => event.preventDefault()}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </button>
  )
}
