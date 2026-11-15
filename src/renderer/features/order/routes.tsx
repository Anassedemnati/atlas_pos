import type { RouteDef } from '../../app/router'
import i18n from '../../app/i18n'
import ar from './i18n/ar.json'
import en from './i18n/en.json'
import fr from './i18n/fr.json'
import { OrderScreen } from './OrderPad'
import '../till/till.css'
import './order.css'

for (const [lang, bundle] of Object.entries({ fr, ar, en })) i18n.addResourceBundle(lang, 'translation', bundle, true, true)

export const routes: RouteDef[] = [
  { path: '/order/:id', component: ({ params }) => <OrderScreen orderId={params['id'] ?? null} key={params['id']} /> },
  { path: '/counter', component: () => <OrderScreen orderId={null} /> }
]
