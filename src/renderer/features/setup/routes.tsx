import i18n from '../../app/i18n'
import type { RouteDef } from '../../app/router'
import { Wizard } from './Wizard'
import ar from './i18n/ar.json'
import en from './i18n/en.json'
import fr from './i18n/fr.json'

// The wizard's texts live beside it (`setupWizard.*`), merged into the shared bundles.
for (const [lang, bundle] of Object.entries({ fr, ar, en })) i18n.addResourceBundle(lang, 'translation', bundle, true, true)

/** `#/setup`: where the main process opens the till window while no installation exists. */
export const routes: RouteDef[] = [{ path: '/setup', component: Wizard }]
