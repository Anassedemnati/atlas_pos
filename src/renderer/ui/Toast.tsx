import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from './Icon'
import { cx } from './metrics'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

export interface ToastApi {
  show: (message: string, tone?: ToastTone, durationMs?: number) => void
  info: (message: string) => void
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

const ICONS: Record<ToastTone, IconName> = { info: 'lightning', success: 'check', warning: 'warning', error: 'warning' }
const DURATION: Record<ToastTone, number> = { info: 4000, success: 3000, warning: 6000, error: 8000 }

const noop = () => {}
const ToastContext = createContext<ToastApi>({ show: noop, info: noop, success: noop, warning: noop, error: noop })

/** `const toast = useToast(); toast.error('…')`. Outside a ToastProvider it does nothing. */
export const useToast = (): ToastApi => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setItems((list) => list.filter((item) => item.id !== id))
  }, [])

  const show = useCallback(
    (message: string, tone: ToastTone = 'info', durationMs?: number) => {
      const id = next.current++
      // The same message twice in a row is one toast, not a stack.
      setItems((list) => [...list.filter((item) => item.message !== message).slice(-3), { id, tone, message }])
      timers.current.set(id, setTimeout(() => dismiss(id), durationMs ?? DURATION[tone]))
    },
    [dismiss]
  )

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => clearTimeout(timer))
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      info: (message) => show(message, 'info'),
      success: (message) => show(message, 'success'),
      warning: (message) => show(message, 'warning'),
      error: (message) => show(message, 'error')
    }),
    [show]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" role="region">
        {items.map((item) => (
          <button key={item.id} type="button" className={cx('toast', `toast--${item.tone}`)} onClick={() => dismiss(item.id)} aria-label={`${item.message} (${t('toast.close')})`}>
            <Icon name={ICONS[item.tone]} size={28} />
            <span className="toast__message">{item.message}</span>
            <Icon name="close" size={22} />
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
