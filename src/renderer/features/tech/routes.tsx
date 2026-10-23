import type { RouteDef } from '../../app/router'
import i18n from '../../app/i18n'
import ar from './i18n/ar.json'
import en from './i18n/en.json'
import fr from './i18n/fr.json'

// The technician menu is a dialog (TillLayout opens it, the recovery screen too): it has no route of its own.
for (const [lang, bundle] of Object.entries({ fr, ar, en })) i18n.addResourceBundle(lang, 'translation', bundle, true, true)

export const routes: RouteDef[] = []
