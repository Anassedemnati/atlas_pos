// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorMessage, invoke, useApi } from '../../../src/renderer/app/api'
import { setLanguage } from '../../../src/renderer/app/i18n'
import { matchRoute, parseHash } from '../../../src/renderer/app/router'
import { ToastProvider } from '../../../src/renderer/ui'
import type { AtlasBridge } from '../../../src/shared/ipc-contract'

afterEach(async () => {
  cleanup()
  delete (window as { atlas?: AtlasBridge }).atlas
  await setLanguage('fr')
})

const bridge = (result: unknown) => {
  const invoke = vi.fn().mockResolvedValue(result)
  ;(window as { atlas?: unknown }).atlas = { invoke, on: () => () => {} }
  return invoke
}

describe('errorMessage', () => {
  it('translates the error key with its params, in the current language', async () => {
    const error = { code: 'locked', messageKey: 'errors.locked', params: { until: '2026-10-22T14:05:00.000Z' } }
    expect(errorMessage(error)).toMatch(/^Trop de tentatives\. Réessayez à \d{2}:\d{2}\.$/)
    await setLanguage('en')
    expect(errorMessage({ code: 'order_empty', messageKey: 'errors.order_empty' })).toBe('The order is empty.')
  })

  it('falls back to the bare code for a code with no text yet', () => {
    expect(errorMessage({ code: 'brand_new_code', messageKey: 'errors.brand_new_code' })).toBe('brand_new_code')
  })
})

describe('invoke and useApi', () => {
  it('turns a missing bridge into a failed result instead of throwing', async () => {
    const result = await invoke('days.current', {})
    expect(result).toEqual({ ok: false, error: { code: 'bridge_unavailable', messageKey: 'errors.bridge_unavailable' } })
  })

  it('shows a refusal as a toast with the translated message and returns the result', async () => {
    const call = bridge({ ok: false, error: { code: 'no_open_day', messageKey: 'errors.no_open_day' } })
    let result: unknown
    function Caller() {
      const api = useApi()
      return <button onClick={async () => (result = await api.call('days.current', {}))}>go</button>
    }
    render(
      <ToastProvider>
        <Caller />
      </ToastProvider>
    )
    await act(async () => void fireEvent.click(screen.getByText('go')))
    expect(call).toHaveBeenCalledWith('days.current', {})
    await waitFor(() => expect(screen.getByText("Aucune journée n'est ouverte.")).toBeTruthy())
    expect(result).toMatchObject({ ok: false })
  })

  it('stays quiet when asked to', async () => {
    bridge({ ok: false, error: { code: 'no_open_day', messageKey: 'errors.no_open_day' } })
    function Caller() {
      const api = useApi()
      return <button onClick={() => void api.call('days.current', {}, { silent: true })}>go</button>
    }
    render(
      <ToastProvider>
        <Caller />
      </ToastProvider>
    )
    await act(async () => void fireEvent.click(screen.getByText('go')))
    expect(screen.queryByText("Aucune journée n'est ouverte.")).toBeNull()
  })
})

describe('router', () => {
  it('splits the hash into a path and a query', () => {
    const { path, query } = parseHash('#/recovery?mode=corrupt')
    expect(path).toBe('/recovery')
    expect(query.get('mode')).toBe('corrupt')
    expect(parseHash('').path).toBe('/')
  })

  it('matches exact paths and :params', () => {
    const page = () => null
    const routes = [
      { path: '/login', component: page },
      { path: '/orders/:id', component: page }
    ]
    expect(matchRoute(routes, '/login')?.route.path).toBe('/login')
    expect(matchRoute(routes, '/orders/o%201')?.params).toEqual({ id: 'o 1' })
    expect(matchRoute(routes, '/orders')).toBeNull()
  })
})
