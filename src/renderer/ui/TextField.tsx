import { useEffect, useId, useRef, type InputHTMLAttributes } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'
import type { KeyboardLayout } from './keyboardLayouts'
import { useTillKeyboard, type KeyboardTarget } from './TillKeyboard'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
  /** A leading icon (a magnifier on a search field). */
  icon?: IconName
  /** Opens the on-screen keyboard on focus. Defaults to the window's setting (true at the till). */
  till?: boolean
  /** Forces a keyboard layout (a code field in Latin letters while the UI is Arabic). */
  keyboard?: KeyboardLayout
  /** The keyboard's Enter key (or Enter on a physical keyboard) was pressed. Without it, the form is submitted. */
  onEnter?: () => void
  /** Hides the label visually (it stays the accessible name), for toolbars and search boxes. */
  hideLabel?: boolean
}

/** A 64 px text field. At the till it opens the on-screen keyboard (or a keypad for `inputMode="numeric|decimal"`). */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  icon,
  till,
  keyboard,
  onEnter,
  hideLabel,
  className,
  id,
  inputMode,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: TextFieldProps) {
  const keyboardHost = useTillKeyboard()
  const onScreen = till ?? keyboardHost.till
  const generated = useId()
  const inputId = id ?? generated
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
  const ref = useRef<HTMLInputElement>(null)
  const target = useRef<KeyboardTarget | null>(null)
  const kind: KeyboardTarget['kind'] = inputMode === 'numeric' || inputMode === 'tel' ? 'numeric' : inputMode === 'decimal' ? 'decimal' : 'text'

  // The target always calls the latest props.
  const latest = useRef({ onChange, onEnter, keyboard, kind })
  latest.current = { onChange, onEnter, keyboard, kind }

  const makeTarget = (input: HTMLInputElement): KeyboardTarget => ({
    input,
    kind: latest.current.kind,
    ...(latest.current.keyboard ? { layout: latest.current.keyboard } : {}),
    onChange: (next) => latest.current.onChange(next),
    onEnter: () => latest.current.onEnter?.()
  })

  useEffect(
    () => () => {
      if (target.current) keyboardHost.blur(target.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <div className={cx('field', error && 'field--error', className)}>
      <label htmlFor={inputId} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      <div className="field__box">
        {icon && <Icon name={icon} size={26} className="field__icon" />}
        <input
          ref={ref}
          id={inputId}
          className="field__input"
          dir="auto"
          value={value}
          // At the till the system keyboard must stay away; a keyboard-wedge scanner still types.
          inputMode={onScreen ? 'none' : inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) => {
            onFocus?.(event)
            if (!onScreen || !ref.current) return
            target.current = makeTarget(ref.current)
            keyboardHost.focus(target.current)
          }}
          onBlur={(event) => {
            onBlur?.(event)
            if (target.current) keyboardHost.blur(target.current)
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.key === 'Enter' && onEnter && !event.defaultPrevented) onEnter()
          }}
          {...rest}
        />
      </div>
      {error ? (
        <p className="field__message field__message--error" id={`${inputId}-error`} role="alert">
          <Icon name="warning" size={20} />
          {error}
        </p>
      ) : (
        hint && (
          <p className="field__message" id={`${inputId}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  )
}
