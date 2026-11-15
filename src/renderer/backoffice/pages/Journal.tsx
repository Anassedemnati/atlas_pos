import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ErrorLineDto, Journal as JournalDto } from '@shared/dto/backoffice'
import { Select, Tabs } from '../../ui'
import { useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { useFormat } from '../format'

const preview = (data: unknown): string => {
  if (data === null || data === undefined) return ''
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** Who did what (the event log), and the errors of the application log. */
export function Journal() {
  const { t } = useTranslation()
  const f = useFormat()
  const [view, setView] = useState<'events' | 'errors'>('events')
  const [family, setFamily] = useState('all')
  const [limit, setLimit] = useState('100')
  const events = useQuery<JournalDto>(view === 'events' ? `/api/journal?limit=${limit}${family === 'all' ? '' : `&type=${encodeURIComponent(family)}`}` : null, { refreshMs: 30_000 })
  const errors = useQuery<ErrorLineDto[]>(view === 'errors' ? '/api/journal/errors' : null)
  // Event types are `family.verb`: the filter offers the families (the server lists every type, whatever the filter), a family selects every type under it.
  const families = useMemo(() => [...new Set((events.data?.types ?? []).map((type) => type.split('.')[0]!))], [events.data?.types])

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.journal')} />
      <Tabs
        variant="segmented"
        value={view}
        onChange={setView}
        aria-label={t('bo.nav.journal')}
        tabs={[
          { id: 'events', label: t('bo.journal.events') },
          { id: 'errors', label: t('bo.journal.errors') }
        ]}
      />
      {view === 'events' && (
        <>
          <div className="cluster">
            <Select label={t('bo.journal.type')} value={family} onChange={setFamily} options={[{ value: 'all', label: t('bo.journal.allTypes') }, ...families.map((k) => ({ value: k, label: k }))]} className="bo-filter" />
            <Select label={t('bo.journal.limit')} value={limit} onChange={setLimit} options={['100', '250', '500'].map((n) => ({ value: n, label: n }))} className="bo-filter" />
          </div>
          <div className="bo-table-wrap">
            <table className="bo-table" data-testid="journal-table">
              <thead>
                <tr>
                  <th>{t('bo.journal.when')}</th>
                  <th>{t('bo.journal.type')}</th>
                  <th>{t('bo.journal.who')}</th>
                  <th>{t('bo.journal.details')}</th>
                </tr>
              </thead>
              <tbody>
                {(events.data?.lines ?? []).map((line) => (
                  <tr key={line.id}>
                    <td>{f.dateTime(line.at)}</td>
                    <td>{line.type}</td>
                    <td>{line.userName ?? '-'}</td>
                    <td className="muted bo-clip" dir="ltr">
                      {preview(line.data)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view === 'errors' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="errors-table">
            <thead>
              <tr>
                <th>{t('bo.journal.when')}</th>
                <th>{t('bo.journal.level')}</th>
                <th>{t('bo.journal.event')}</th>
                <th>{t('bo.journal.details')}</th>
              </tr>
            </thead>
            <tbody>
              {(errors.data ?? []).map((line, index) => (
                <tr key={index}>
                  <td>{f.dateTime(line.time)}</td>
                  <td>{line.level}</td>
                  <td>{line.event}</td>
                  <td className="muted bo-clip" dir="ltr">
                    {preview(line.data)}
                  </td>
                </tr>
              ))}
              {errors.data && errors.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted bo-empty">
                    {t('bo.journal.noErrors')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
