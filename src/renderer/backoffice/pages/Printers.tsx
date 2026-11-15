import { useTranslation } from 'react-i18next'
import type { PrintersDto } from '@shared/dto/backoffice'
import { Button, Card, Pill, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { useFormat } from '../format'

/** The printers, which categories print where, the jobs that need a look, and the test page. Adding one is done at the till (technician). */
export function Printers() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const query = useQuery<PrintersDto>('/api/printers', { refreshMs: 20_000 })
  const data = query.data
  const printerName = (id: string): string => data?.printers.find((p) => p.id === id)?.name ?? id

  const test = async (id: string) => {
    const result = await api.call('POST', `/api/printers/${id}/test`)
    if (result.ok) toast.success(t('bo.printers.testSent'))
  }
  const job = async (id: string, action: 'reprint' | 'dismiss') => {
    const result = await api.call('POST', `/api/printers/jobs/${id}/${action}`)
    if (result.ok) query.reload()
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.printers')} />
      <p className="muted">{t('bo.printers.technicianNote')}</p>
      <div className="bo-table-wrap">
        <table className="bo-table" data-testid="printers-table">
          <thead>
            <tr>
              <th>{t('bo.products.name')}</th>
              <th>{t('bo.printers.role')}</th>
              <th>{t('bo.printers.kind')}</th>
              <th>{t('bo.printers.width')}</th>
              <th>{t('bo.printers.status')}</th>
              <th aria-label={t('common.test')} />
            </tr>
          </thead>
          <tbody>
            {(data?.printers ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{t(`bo.printers.roles.${p.role}`, { defaultValue: p.role })}</td>
                <td>
                  {t(`bo.printers.kinds.${p.kind}`, { defaultValue: p.kind })}
                  {p.address && <span className="bo-sub">{p.address}</span>}
                </td>
                <td>{p.widthMm} mm</td>
                <td>
                  <Pill tone={p.active ? 'success' : 'neutral'} dot>
                    {p.active ? t('common.enabled') : t('common.disabled')}
                  </Pill>
                </td>
                <td>
                  <Button variant="ghost" onClick={() => void test(p.id)} disabled={!p.active} data-testid={`printer-test-${p.name}`}>
                    {t('bo.printers.test')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="h3">{t('bo.printers.routing')}</h2>
      <div className="bo-table-wrap">
        <table className="bo-table" data-testid="routing-table">
          <thead>
            <tr>
              <th>{t('bo.products.category')}</th>
              <th>{t('bo.printers.printsOn')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.routing ?? []).map((route) => (
              <tr key={route.categoryId}>
                <td>{f.name(route.categoryName)}</td>
                <td>{route.printerIds.length > 0 ? route.printerIds.map(printerName).join(', ') : <span className="muted">{t('bo.printers.noRoute')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="h3">{t('bo.printers.jobs')}</h2>
      {(data?.jobs ?? []).length === 0 ? (
        <Card>
          <p className="muted">{t('bo.printers.noJobs')}</p>
        </Card>
      ) : (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="jobs-table">
            <thead>
              <tr>
                <th>{t('bo.printers.job')}</th>
                <th>{t('bo.printers.status')}</th>
                <th>{t('bo.journal.when')}</th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {(data?.jobs ?? []).map((j) => (
                <tr key={j.id}>
                  <td>
                    {t(`bo.printers.jobKinds.${j.kind}`, { defaultValue: j.kind })} - {j.printerName ?? printerName(j.printerId)}
                  </td>
                  <td>
                    <Pill tone={j.status === 'failed' ? 'danger' : 'warning'} dot>
                      {t(`bo.printers.jobStatus.${j.status}`, { defaultValue: j.status })}
                    </Pill>
                    {j.error && <span className="bo-sub">{j.error}</span>}
                  </td>
                  <td>{f.dateTime(j.updatedAt)}</td>
                  <td>
                    <div className="cluster">
                      <Button variant="ghost" onClick={() => void job(j.id, 'reprint')}>
                        {t('bo.printers.reprint')}
                      </Button>
                      <Button variant="secondary" onClick={() => void job(j.id, 'dismiss')}>
                        {t('bo.printers.dismiss')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
