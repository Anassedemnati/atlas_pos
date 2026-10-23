import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportSummary } from '@shared/dto'
import type { ImportPreviewDto } from '@shared/dto/backoffice'
import { Button, Modal, Select, useToast } from '../../ui'
import { useApi } from '../api'
import { useFormat } from '../format'

/**
 * The Excel / CSV import: choose a file, see what it holds (the valid rows and every problem, row by row), then apply.
 * Applying is refused while there is an error: the server keeps the preview and applies only a clean one.
 */
export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState(false)

  const close = () => {
    setPreview(null)
    setFileName(null)
    setMode('merge')
    onClose()
  }

  const choose = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setFileName(file.name)
    setPreview(null)
    const result = await api.upload<ImportPreviewDto>('/api/catalog/import/preview', file, { 'x-file-name': encodeURIComponent(file.name) })
    setBusy(false)
    if (result.ok) setPreview(result.value)
    if (input.current) input.current.value = ''
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    const result = await api.call<ImportSummary>('POST', '/api/catalog/import/apply', { previewId: preview.previewId, mode })
    setBusy(false)
    if (!result.ok) return
    const s = result.value
    toast.success(t('bo.import.done', { created: s.created, updated: s.updated, deleted: s.deleted, deactivated: s.deactivated }))
    onImported()
    close()
  }

  const clean = preview !== null && preview.errors.length === 0 && preview.rows.length > 0
  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={t('bo.import.title')}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" onClick={() => void apply()} disabled={busy || !clean} data-testid="import-apply">
            {t('bo.import.apply')}
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="import-dialog">
        <p className="muted">{t('bo.import.hint')}</p>
        <div className="cluster">
          <input ref={input} type="file" accept=".csv,.xlsx,text/csv" className="sr-only" data-testid="import-file" onChange={(event) => void choose(event.target.files?.[0])} />
          <Button variant="ghost" icon="plus" onClick={() => input.current?.click()} disabled={busy}>
            {t('bo.import.choose')}
          </Button>
          {fileName && <span className="muted">{fileName}</span>}
          <a className="bo-link" href="/api/catalog/export?format=xlsx" download>
            {t('bo.import.template')}
          </a>
        </div>
        {preview && (
          <>
            <p data-testid="import-summary" className={preview.errors.length > 0 ? 'error-text' : undefined}>
              {preview.errors.length > 0 ? t('bo.import.withErrors', { count: preview.errors.length }) : t('bo.import.ready', { count: preview.rows.length })}
            </p>
            {preview.errors.length > 0 && (
              <div className="bo-table-wrap">
                <table className="bo-table" data-testid="import-errors">
                  <thead>
                    <tr>
                      <th>{t('bo.import.row')}</th>
                      <th>{t('bo.import.column')}</th>
                      <th>{t('bo.import.problem')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.map((error, index) => (
                      <tr key={index}>
                        <td>{error.row || '-'}</td>
                        <td>{error.field}</td>
                        <td>{t(error.messageKey, { defaultValue: error.messageKey })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.rows.length > 0 && (
              <div className="bo-table-wrap">
                <table className="bo-table" data-testid="import-rows">
                  <thead>
                    <tr>
                      <th>{t('bo.import.row')}</th>
                      <th>{t('bo.products.category')}</th>
                      <th>{t('bo.products.name')}</th>
                      <th>{t('bo.products.price')}</th>
                      <th>{t('bo.products.vat')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 50).map((row) => (
                      <tr key={row.row}>
                        <td>{row.row}</td>
                        <td>{row.category}</td>
                        <td>{row.nameFr}</td>
                        <td className="figure">{f.money(row.priceCents)}</td>
                        <td>{f.vat(row.vatBp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {clean && (
              <Select
                label={t('bo.import.mode')}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'merge', label: t('bo.import.merge') },
                  { value: 'replace', label: t('bo.import.replace') }
                ]}
              />
            )}
            {clean && mode === 'replace' && <p className="error-text">{t('bo.import.replaceWarning')}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
