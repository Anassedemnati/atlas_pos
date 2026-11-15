/// <reference path="../atlas.d.ts" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AtlasEventType } from '@shared/dto'
import type { Channel, In, Out } from '@shared/ipc-contract'
import type { AppError, Result } from '@shared/result'
import { useToast } from '../ui/Toast'
import i18n from './i18n'
import { useEvent } from './useEvent'

const failure = (code: string): Result<never> => ({ ok: false, error: { code, messageKey: `errors.${code}` } })

/**
 * A typed call to the main process. Never throws: a missing bridge (the page opened in a browser) or a
 * rejected call becomes a failed `Result`, like any refusal.
 */
export async function invoke<C extends Channel>(channel: C, input: In<C>): Promise<Result<Out<C>>> {
  const bridge = typeof window === 'undefined' ? undefined : window.atlas
  if (!bridge) return failure('bridge_unavailable')
  try {
    return await bridge.invoke(channel, input)
  } catch {
    return failure('internal_error')
  }
}

const clock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/**
 * The sentence for an error: `t(error.messageKey)` filled with the error's params, or the bare code when
 * the key is unknown (a code added in the main process before its text). `until` (a lock) is shown as a time.
 */
export function errorMessage(error: AppError): string {
  const params: Record<string, unknown> = { ...error.params }
  if (typeof params.until === 'string') {
    const date = new Date(params.until)
    if (!Number.isNaN(date.getTime())) params.until = clock.format(date)
  }
  return i18n.t(error.messageKey, { ...params, defaultValue: error.code })
}

export interface CallOptions {
  /** Do not toast a failure (the caller shows it itself, next to the field it concerns). */
  silent?: boolean
}

export interface Api {
  /** Calls a channel; a failure is toasted (unless `silent`) and returned as `{ ok: false }`. */
  call: <C extends Channel>(channel: C, input: In<C>, options?: CallOptions) => Promise<Result<Out<C>>>
  /** Like `call`, but returns the value, or `null` after a failure. */
  callValue: <C extends Channel>(channel: C, input: In<C>, options?: CallOptions) => Promise<Out<C> | null>
}

export function useApi(): Api {
  const toast = useToast()
  const call = useCallback(
    async function <C extends Channel>(channel: C, input: In<C>, options?: CallOptions): Promise<Result<Out<C>>> {
      const result = await invoke(channel, input)
      if (!result.ok && !options?.silent) toast.error(errorMessage(result.error))
      return result
    },
    [toast]
  )
  const callValue = useCallback(
    async function <C extends Channel>(channel: C, input: In<C>, options?: CallOptions): Promise<Out<C> | null> {
      const result = await call(channel, input, options)
      return result.ok ? result.value : null
    },
    [call]
  )
  return useMemo(() => ({ call, callValue }), [call, callValue])
}

export interface QueryOptions {
  /** False waits (the input is not ready). */
  enabled?: boolean
  /** Events that make the data stale: it is fetched again when one arrives. */
  refreshOn?: AtlasEventType[]
  silent?: boolean
}

export interface QueryState<T> {
  data: T | undefined
  error: AppError | null
  loading: boolean
  reload: () => void
}

/** Loads a channel when the component mounts (and when `input` changes or a `refreshOn` event arrives). */
export function useQuery<C extends Channel>(channel: C, input: In<C>, options: QueryOptions = {}): QueryState<Out<C>> {
  const { enabled = true, refreshOn, silent } = options
  const toast = useToast()
  const [state, setState] = useState<{ data: Out<C> | undefined; error: AppError | null; loading: boolean }>({ data: undefined, error: null, loading: enabled })
  const run = useRef(0)
  const latestInput = useRef(input)
  latestInput.current = input
  const inputKey = JSON.stringify(input)

  const load = useCallback(() => {
    const mine = ++run.current
    setState((previous) => ({ ...previous, loading: true }))
    void invoke(channel, latestInput.current).then((result) => {
      if (mine !== run.current) return // a newer request is in flight
      if (result.ok) setState({ data: result.value, error: null, loading: false })
      else {
        if (!silent) toast.error(errorMessage(result.error))
        setState((previous) => ({ ...previous, error: result.error, loading: false }))
      }
    })
  }, [channel, silent, toast])

  useEffect(() => {
    if (enabled) load()
    return () => {
      run.current++
    }
  }, [enabled, inputKey, load])

  const events = useMemo(() => refreshOn ?? [], [refreshOn])
  useEventList(events, load)

  return { ...state, reload: load }
}

/** `useEvent` for several types at once (the list must be stable between renders). */
function useEventList(types: readonly AtlasEventType[], callback: () => void): void {
  const key = types.join('|')
  useEffect(() => {
    if (!types.length || typeof window === 'undefined' || !window.atlas) return
    const stops = types.map((type) => window.atlas.on(type, callback))
    return () => stops.forEach((stop) => stop())
    // `key` stands for the list contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, callback])
}

export { useEvent }
