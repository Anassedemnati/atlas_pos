import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionDto } from '@shared/dto'
import type { AppError, Result } from '@shared/result'
import { errorMessage } from '../app/api'
import { useToast } from '../ui'

/** The token the server gave at the login (and again on a page reload): sent with every request that changes something. */
let csrfToken = ''
export const setCsrfToken = (token: string): void => {
  csrfToken = token
}

let onSignedOut: () => void = () => {}
/** Called when the server says the session is over (expired, signed out elsewhere, rights withdrawn). */
export const setSignedOutHandler = (handler: () => void): void => {
  onSignedOut = handler
}

const failure = (code: string): Result<never> => ({ ok: false, error: { code, messageKey: `errors.${code}` } })

async function send<T>(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Result<T>> {
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken }), ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {})
    })
    const json = (await response.json().catch(() => null)) as Result<T> | null
    if (!json || typeof json !== 'object' || !('ok' in json)) return failure('internal_error')
    if (!json.ok && response.status === 401 && json.error.code === 'not_signed_in') onSignedOut()
    return json
  } catch {
    return failure('network')
  }
}

/** A JSON call. Never throws: a refusal, a network failure and a bad answer are all a failed `Result`. */
export const http = <T,>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Result<T>> =>
  send<T>(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

/** A file as the raw body (a sheet to import, a photo). */
export const upload = <T,>(path: string, file: Blob, headers: Record<string, string> = {}): Promise<Result<T>> =>
  send<T>('POST', path, { body: file, headers: { 'content-type': 'application/octet-stream', ...headers } })

export interface CallOptions {
  /** Do not toast a failure (the caller shows it next to the field). */
  silent?: boolean
}

export interface Api {
  /** A call whose failure is toasted (unless `silent`) and returned. */
  call: <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, options?: CallOptions) => Promise<Result<T>>
  upload: <T>(path: string, file: Blob, headers?: Record<string, string>, options?: CallOptions) => Promise<Result<T>>
}

export function useApi(): Api {
  const toast = useToast()
  return useMemo<Api>(
    () => ({
      async call(method, path, body, options) {
        const result = await http<never>(method, path, body)
        if (!result.ok && !options?.silent) toast.error(errorMessage(result.error))
        return result
      },
      async upload(path, file, headers, options) {
        const result = await upload<never>(path, file, headers)
        if (!result.ok && !options?.silent) toast.error(errorMessage(result.error))
        return result
      }
    }),
    [toast]
  )
}

export interface QueryState<T> {
  data: T | undefined
  error: AppError | null
  loading: boolean
  reload: () => void
}

/** Loads a GET path when the component mounts and whenever the path changes (`null` waits). `refreshMs` polls. */
export function useQuery<T>(path: string | null, options: { refreshMs?: number; silent?: boolean } = {}): QueryState<T> {
  const toast = useToast()
  const [state, setState] = useState<{ data: T | undefined; error: AppError | null; loading: boolean }>({ data: undefined, error: null, loading: path !== null })
  const run = useRef(0)
  const load = useCallback(() => {
    if (path === null) return
    const mine = ++run.current
    setState((previous) => ({ ...previous, loading: true }))
    void http<T>('GET', path).then((result) => {
      if (mine !== run.current) return
      if (result.ok) setState({ data: result.value, error: null, loading: false })
      else {
        if (!options.silent) toast.error(errorMessage(result.error))
        setState((previous) => ({ ...previous, error: result.error, loading: false }))
      }
    })
  }, [path, options.silent, toast])
  useEffect(() => {
    load()
    return () => {
      run.current++
    }
  }, [load])
  useEffect(() => {
    if (!options.refreshMs || path === null) return
    const timer = setInterval(load, options.refreshMs)
    return () => clearInterval(timer)
  }, [load, options.refreshMs, path])
  return { ...state, reload: load }
}

export interface SessionContextValue {
  user: SessionDto
  signOut: () => void
}

export const SessionContext = createContext<SessionContextValue | null>(null)

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession outside a signed-in page')
  return value
}

export const SessionProvider = ({ value, children }: { value: SessionContextValue; children: ReactNode }) => (
  <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
)
