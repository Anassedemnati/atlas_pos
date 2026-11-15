import { useSyncExternalStore, type ComponentType } from 'react'

/** What a routed screen receives. */
export interface RouteProps {
  /** `:name` segments of the path. */
  params: Record<string, string>
  /** The query string (`#/recovery?mode=corrupt`). */
  query: URLSearchParams
}

export interface RouteDef {
  /** `/login`, `/orders/:id`. Exact match, segment by segment. */
  path: string
  component: ComponentType<RouteProps>
}

/** `#/recovery?mode=corrupt` -> `{ path: '/recovery', query: mode=corrupt }`. */
export function parseHash(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('?')
  const path = (cut >= 0 ? raw.slice(0, cut) : raw) || '/'
  return { path: path.startsWith('/') ? path : `/${path}`, query: new URLSearchParams(cut >= 0 ? raw.slice(cut + 1) : '') }
}

export function matchRoute(routes: readonly RouteDef[], path: string): { route: RouteDef; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean)
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean)
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    const hit = pattern.every((segment, index) => {
      const part = parts[index]!
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(part)
        return true
      }
      return segment === part
    })
    if (hit) return { route, params }
  }
  return null
}

/** `navigate('/login')` or `navigate('#/recovery?mode=safe')`. */
export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to : `#${to}`
}

const subscribe = (callback: () => void): (() => void) => {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export const useHash = (): string => useSyncExternalStore(subscribe, () => window.location.hash)

export interface RouterProps {
  routes: readonly RouteDef[]
  /** Shown for `/` and for a path no route matches. */
  fallback: ComponentType<RouteProps>
}

/** A hash router: the screen is picked from `window.location.hash`, so the main process can open any route. */
export function Router({ routes, fallback: Fallback }: RouterProps) {
  const { path, query } = parseHash(useHash())
  const hit = matchRoute(routes, path)
  if (!hit) return <Fallback params={{}} query={query} />
  const Screen = hit.route.component
  // Keyed by the route so each screen starts with a clean state.
  return <Screen key={hit.route.path} params={hit.params} query={query} />
}
