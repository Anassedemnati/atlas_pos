import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Keypad } from './Keypad'
import { KEY_BACKSPACE, KEY_ENTER, OnScreenKeyboard } from './OnScreenKeyboard'
import { layoutForLanguage, type KeyboardLayout } from './keyboardLayouts'

/** What a TextField tells the keyboard when it takes the focus. */
export interface KeyboardTarget {
  input: HTMLInputElement | HTMLTextAreaElement
  /** `numeric`: digits only (a keypad); `decimal`: digits and a comma (a keypad); `text`: the full keyboard. */
  kind: 'text' | 'numeric' | 'decimal'
  layout?: KeyboardLayout
  onChange: (value: string) => void
  onEnter?: () => void
}

interface TillKeyboardContextValue {
  /** True in the till window: fields then open the on-screen keyboard and keep the system one away. */
  till: boolean
  focus: (target: KeyboardTarget) => void
  blur: (target: KeyboardTarget) => void
}

const TillKeyboardContext = createContext<TillKeyboardContextValue>({ till: false, focus: () => {}, blur: () => {} })

export const useTillKeyboard = (): TillKeyboardContextValue => useContext(TillKeyboardContext)

/** Types one key into the field behind `target`, at the caret (or over the selection). */
export function typeInto(target: KeyboardTarget, key: string): void {
  const { input } = target
  if (key === KEY_ENTER) {
    if (target.onEnter) target.onEnter()
    else if (input.form) input.form.requestSubmit()
    else input.blur()
    return
  }
  const value = input.value
  const start = input.selectionStart ?? value.length
  const end = input.selectionEnd ?? start
  let next: string
  let caret: number
  if (key === KEY_BACKSPACE) {
    if (start !== end) {
      next = value.slice(0, start) + value.slice(end)
      caret = start
    } else if (start > 0) {
      next = value.slice(0, start - 1) + value.slice(start)
      caret = start - 1
    } else return
  } else {
    next = value.slice(0, start) + key + value.slice(end)
    caret = start + key.length
  }
  if (input.maxLength > 0 && next.length > input.maxLength) return
  target.onChange(next)
  // The controlled input is re-rendered with the new value (caret to the end): put the caret back.
  requestAnimationFrame(() => {
    if (document.activeElement === input) input.setSelectionRange(caret, caret)
  })
}

export interface TillKeyboardProviderProps {
  /** Default true: this is the till window. The web back office passes false (its users have a keyboard). */
  till?: boolean
  children: ReactNode
}

/**
 * Hosts the one on-screen keyboard of the window. A `TextField` registers here on focus; the keyboard
 * opens at the bottom of the screen and reserves its height (`--kbd-height`) so nothing hides behind it,
 * and closes when the focus leaves the fields.
 */
export function TillKeyboardProvider({ till = true, children }: TillKeyboardProviderProps) {
  const { i18n, t } = useTranslation()
  const [target, setTarget] = useState<KeyboardTarget | null>(null)
  const dock = useRef<HTMLDivElement>(null)

  const focus = useCallback((next: KeyboardTarget) => setTarget(next), [])
  const blur = useCallback((gone: KeyboardTarget) => {
    // A tap on another field blurs this one and focuses that one in the same gesture: decide after it.
    setTimeout(() => setTarget((current) => (current === gone && document.activeElement !== gone.input ? null : current)), 0)
  }, [])
  const value = useMemo(() => ({ till, focus, blur }), [till, focus, blur])

  // Reserve the dock's height, and bring the field into view above it.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!target || !dock.current) {
      root.style.setProperty('--kbd-height', '0px')
      return
    }
    const element = dock.current
    const measure = () => root.style.setProperty('--kbd-height', `${element.offsetHeight}px`)
    measure()
    target.input.scrollIntoView?.({ block: 'center' })
    if (typeof ResizeObserver === 'undefined') return () => root.style.setProperty('--kbd-height', '0px')
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.setProperty('--kbd-height', '0px')
    }
  }, [target])

  useEffect(() => {
    if (!till) setTarget(null)
  }, [till])

  return (
    <TillKeyboardContext.Provider value={value}>
      {children}
      {till && target && (
        <div ref={dock} className="kbd-dock" data-testid="kbd-dock" onMouseDown={(event) => event.preventDefault()}>
          {target.kind === 'text' ? (
            <OnScreenKeyboard
              layout={target.layout ?? layoutForLanguage(i18n.language)}
              onKey={(key) => typeInto(target, key)}
              onHide={() => {
                target.input.blur()
                setTarget(null)
              }}
            />
          ) : (
            <Keypad
              mode={target.kind === 'decimal' ? 'qty' : 'pin'}
              hideDisplay
              minLength={0}
              enterLabel={t('common.ok')}
              onDigit={(key) => typeInto(target, key)}
              onBackspace={() => typeInto(target, KEY_BACKSPACE)}
              onEnter={() => typeInto(target, KEY_ENTER)}
              className="kbd-dock__keypad"
            />
          )}
        </div>
      )}
    </TillKeyboardContext.Provider>
  )
}
