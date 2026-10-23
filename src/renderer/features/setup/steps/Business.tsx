import { useTranslation } from 'react-i18next'
import type { ImportError, SetupBusinessType } from '@shared/dto'
import { formatMoney } from '@shared/money'
import { MODULES, type ModuleKey } from '@shared/modules'
import { currentLanguage } from '../../../app/i18n'
import i18n from '../../../app/i18n'
import { Button, Card, Icon, Pill, Toggle, type IconName } from '../../../ui'
import { Section } from '../components/Section'
import { usePickers } from '../components/useFilePicker'
import { useWizard } from '../wizard-context'

const TYPE_ICONS: Record<SetupBusinessType, IconName> = { restaurant: 'utensils', cafe: 'coffee', bakery: 'bread', retail: 'store' }
const TYPES = Object.keys(TYPE_ICONS) as SetupBusinessType[]
const MODULE_ICONS: Record<ModuleKey, IconName> = { tables: 'table', kitchen: 'utensils', menus: 'cart', customers: 'user', stock: 'chart', barcode: 'barcode', scale: 'gear' }
const PREVIEW_ROWS = 6
const ERROR_ROWS = 8

const errorText = (error: ImportError): string => {
  const message = i18n.t(error.messageKey, { defaultValue: error.messageKey })
  return error.row > 0 ? `${i18n.t('setupWizard.business.line', { row: error.row })} · ${error.field} : ${message}` : message
}

/** Step 2: the type of business (it pre-sets the modules), the modules, and where the catalogue comes from. */
export function Business() {
  const { t } = useTranslation()
  const { draft, templates, profile, edit, errors, setErrors, api, importPreview, setImportPreview, importName, setImportName } = useWizard()
  const { pickFile } = usePickers()
  const lang = currentLanguage()

  const chooseType = (type: SetupBusinessType) => {
    const template = templates.find((item) => item.id === type)
    edit({ businessType: type, ...(template ? { modules: { ...template.modules } } : {}) })
  }

  const chooseSource = (source: 'template' | 'import' | 'empty' | 'profile') => edit({ catalogSource: source })

  const chooseFile = async () => {
    const path = await pickFile(t('setupWizard.business.importTitle'), ['xlsx', 'xls', 'csv'])
    if (!path) return
    const result = await api.call('setup.previewImport', { path })
    if (!result.ok) return
    setImportPreview(result.value)
    setErrors({})
    setImportName(path.split(/[\\/]/).pop() ?? path)
    chooseSource('import')
  }

  const current = templates.find((item) => item.id === draft.businessType)
  const sources: { id: 'template' | 'import' | 'empty' | 'profile'; text: string }[] = [
    ...(profile ? [{ id: 'profile' as const, text: t('setupWizard.business.sourceProfileText', { products: profile.counts.products, categories: profile.counts.categories }) }] : []),
    { id: 'template', text: t('setupWizard.business.sourceTemplateText', { products: current?.counts.products ?? 0, categories: current?.counts.categories ?? 0 }) },
    { id: 'import', text: t('setupWizard.business.sourceImportText') },
    { id: 'empty', text: t('setupWizard.business.sourceEmptyText') }
  ]

  return (
    <div className="stack wiz-stack">
      <div className="wiz-grid wiz-grid--4" role="group" aria-label={t('setupWizard.business.title')}>
        {TYPES.map((type) => {
          const template = templates.find((item) => item.id === type)
          return (
            <Card key={type} selected={draft.businessType === type} onClick={() => chooseType(type)} className="wiz-type" data-testid={`type-${type}`}>
              {draft.businessType === type && (
                <span className="wiz-type__check">
                  <Icon name="check" size={24} strokeWidth={3} />
                </span>
              )}
              <Icon name={TYPE_ICONS[type]} size={56} />
              <span>{t(`setupWizard.business.types.${type}`)}</span>
              {template && <span className="wiz-type__sub">{t('setupWizard.business.counts', { products: template.counts.products, tables: template.counts.tables })}</span>}
            </Card>
          )
        })}
      </div>

      <Section title={t('setupWizard.business.modules')}>
        <div className="wiz-modules">
          {MODULES.map((module) => (
            <Toggle
              key={module}
              icon={MODULE_ICONS[module]}
              label={t(`setupWizard.modules.${module}`)}
              checked={draft.modules[module] === true}
              onChange={(checked) => edit((state) => ({ modules: { ...state.modules, [module]: checked } }))}
            />
          ))}
        </div>
      </Section>

      <Section title={t('setupWizard.business.catalog')} hint={t('setupWizard.business.catalogHint')}>
        <div className="wiz-grid wiz-grid--auto" role="radiogroup" aria-label={t('setupWizard.business.catalog')}>
          {sources.map((source) => (
            <Card
              key={source.id}
              selected={draft.catalogSource === source.id}
              onClick={() => chooseSource(source.id)}
              className="wiz-source"
              data-testid={`source-${source.id}`}
            >
              <span className="wiz-source__title">{t(`setupWizard.business.source.${source.id}`)}</span>
              <span className="wiz-source__text">{source.text}</span>
            </Card>
          ))}
        </div>

        {draft.catalogSource === 'import' && (
          <div className="wiz-import">
            <div className="cluster">
              <Button variant="ghost" icon="plus" onClick={() => void chooseFile()}>
                {importPreview || importName ? t('setupWizard.business.importOther') : t('setupWizard.business.importChoose')}
              </Button>
              {importName && <span className="wiz-import__name">{importName}</span>}
              {importPreview && (
                <>
                  <Pill tone="success" icon="check">
                    {t('setupWizard.business.importRows', { count: importPreview.rows.length })}
                  </Pill>
                  {importPreview.errors.length > 0 && <Pill tone="danger" icon="warning">{t('setupWizard.business.importErrors', { count: importPreview.errors.length })}</Pill>}
                </>
              )}
              {!importPreview && draft.importFile && <Pill tone="neutral">{t('setupWizard.business.importKept')}</Pill>}
            </div>
            {errors['importFile'] && (
              <p className="field__message field__message--error wiz__error-anchor" role="alert">
                <Icon name="warning" size={20} />
                {errors['importFile']}
              </p>
            )}
            {importPreview && importPreview.errors.length > 0 && (
              <ul className="wiz-issues">
                {importPreview.errors.slice(0, ERROR_ROWS).map((error, index) => (
                  <li key={`${error.row}-${error.field}-${index}`}>{errorText(error)}</li>
                ))}
                {importPreview.errors.length > ERROR_ROWS && <li className="muted">{t('setupWizard.business.importMore', { count: importPreview.errors.length - ERROR_ROWS })}</li>}
              </ul>
            )}
            {importPreview && importPreview.rows.length > 0 && (
              <div className="wiz-table-wrap">
                <table className="wiz-table">
                  <thead>
                    <tr>
                      <th>{t('setupWizard.business.col.category')}</th>
                      <th>{t('setupWizard.business.col.name')}</th>
                      <th className="wiz-table__num">{t('setupWizard.business.col.price')}</th>
                      <th className="wiz-table__num">{t('setupWizard.business.col.vat')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.rows.slice(0, PREVIEW_ROWS).map((row) => (
                      <tr key={row.row}>
                        <td>{row.category}</td>
                        <td>{row.nameFr}</td>
                        <td className="wiz-table__num figure">{formatMoney(row.priceCents, lang)}</td>
                        <td className="wiz-table__num">{row.vatBp / 100} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {importPreview.rows.length > PREVIEW_ROWS && <p className="muted">{t('setupWizard.business.importMore', { count: importPreview.rows.length - PREVIEW_ROWS })}</p>}
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
