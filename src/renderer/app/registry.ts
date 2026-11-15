import type { RouteDef } from './router'

// Every feature folder owns its screens: `src/renderer/features/<name>/routes.tsx` exports `routes: RouteDef[]`.
// They are picked up here, so adding a feature never touches App.tsx.
const modules = import.meta.glob<{ routes: RouteDef[] }>('../features/*/routes.tsx', { eager: true })

export const routes: RouteDef[] = Object.values(modules).flatMap((module) => module.routes)
