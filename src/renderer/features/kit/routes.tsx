import type { RouteDef } from '../../app/router'
import { KitPage } from './KitPage'

/** `#/kit`: every component of the UI kit on one screen (a development aid). */
export const routes: RouteDef[] = [{ path: '/kit', component: KitPage }]
