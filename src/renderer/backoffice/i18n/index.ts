import i18n from '../../app/i18n'
import ar from './ar.json'
import en from './en.json'
import fr from './fr.json'

// The back office texts, merged into the shared catalogues (`common.*`, `errors.*`, `lang.*` come from there).
for (const [lang, bundle] of Object.entries({ fr, ar, en })) i18n.addResourceBundle(lang, 'translation', bundle, true, true)
