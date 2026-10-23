import type { RouteDef } from '../../app/router'
import i18n from '../../app/i18n'
import { CustomerDisplay } from './CustomerDisplay'
import ar from './i18n/ar.json'
import en from './i18n/en.json'
import fr from './i18n/fr.json'
import './display.css'

for (const [lang, bundle] of Object.entries({ fr, ar, en })) i18n.addResourceBundle(lang, 'translation', bundle, true, true)

export const routes: RouteDef[] = [{ path: '/display', component: CustomerDisplay }]
