import { createContext, useContext, useEffect, useState } from 'react'
import type { CatalogDto, FloorDto, PaymentMethodDto, SessionDto } from '@shared/dto'
import { invoke } from '../../app/api'
import { navigate } from '../../app/router'

/** What every till screen reads: who is signed in, the settings, the catalogue, the floor and the payment methods. */
export interface TillData {
  session: SessionDto
  settings: Record<string, unknown>
  catalog: CatalogDto
  floor: FloorDto
  methods: PaymentMethodDto[]
}

export const TillContext = createContext<TillData | null>(null)

/** The data of the till screens; only valid below a `TillLayout`. */
export function useTill(): TillData {
  const value = useContext(TillContext)
  if (!value) throw new Error('useTill outside a TillLayout')
  return value
}

export const can = (data: TillData, permission: SessionDto['permissions'][number]): boolean => data.session.permissions.includes(permission)

export function setting<T>(data: Pick<TillData, 'settings'>, key: string, fallback: T): T {
  const value = data.settings[key]
  return value === undefined || value === null ? fallback : (value as T)
}

export const moduleOn = (data: Pick<TillData, 'settings'>, key: string): boolean =>
  setting<Record<string, boolean>>(data, 'modules', {})[key] === true

let cache: TillData | null = null

/** Forgets what was loaded (sign-out, a restore): the next screen loads again. */
export function clearTillData(): void {
  cache = null
}

/**
 * Loads the data of the till screens. A signed-out window is sent to the login. The last result is kept so that
 * moving between screens shows them at once, and refreshed in the background.
 */
export async function loadTillData(): Promise<TillData | null> {
  const current = await invoke('users.current', {})
  if (!current.ok || !current.value) {
    clearTillData()
    return null
  }
  const [settings, catalog, floor, methods] = await Promise.all([
    invoke('settings.getAll', {}),
    invoke('catalog.list', {}),
    invoke('floor.list', {}),
    invoke('payments.list', {})
  ])
  if (!settings.ok || !catalog.ok || !floor.ok || !methods.ok) return cache
  cache = { session: current.value, settings: settings.value, catalog: catalog.value, floor: floor.value, methods: methods.value }
  return cache
}

/** The till data (`undefined` while loading, `null` once the window is known to be signed out: it goes to the login). */
export function useTillLoader(): TillData | null | undefined {
  const [data, setData] = useState<TillData | null | undefined>(cache ?? undefined)
  useEffect(() => {
    let cancelled = false
    const refresh = () =>
      void loadTillData().then((next) => {
        if (cancelled) return
        if (next === null) navigate('/login')
        else setData(next)
      })
    refresh()
    const stops = ['catalog.changed', 'settings.changed'].map((type) => window.atlas?.on(type as 'catalog.changed', refresh))
    return () => {
      cancelled = true
      stops.forEach((stop) => stop?.())
    }
  }, [])
  return data
}

/** Ends the session of this window and shows the login (the technician mode ends with it). */
export async function signOut(): Promise<void> {
  await invoke('users.logout', {})
  clearTillData()
  navigate('/login')
}
