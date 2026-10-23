import { PlaceholderPage } from '../../app/PlaceholderPage'
import type { RouteDef } from '../../app/router'

// Placeholder: the task that builds this screen replaces the component below.
export const routes: RouteDef[] = [{ path: '/display', component: () => <PlaceholderPage titleKey="routes.display" bare /> }]
