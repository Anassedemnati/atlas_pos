import { useTranslation } from 'react-i18next'
import type { LocalizedName } from '@shared/names'
import { TextField } from '../../ui'

/** The name in French (required), Arabic and English. Arabic is typed right to left. */
export function NamesFields({ value, onChange, error }: { value: LocalizedName; onChange: (name: LocalizedName) => void; error?: string | undefined }) {
  const { t } = useTranslation()
  return (
    <div className="bo-names">
      <TextField label={t('bo.names.fr')} value={value.fr} onChange={(fr) => onChange({ ...value, fr })} error={error} data-testid="name-fr" />
      <TextField label={t('bo.names.ar')} value={value.ar ?? ''} onChange={(ar) => onChange({ ...value, ar })} dir="rtl" lang="ar" data-testid="name-ar" />
      <TextField label={t('bo.names.en')} value={value.en ?? ''} onChange={(en) => onChange({ ...value, en })} lang="en" data-testid="name-en" />
    </div>
  )
}
