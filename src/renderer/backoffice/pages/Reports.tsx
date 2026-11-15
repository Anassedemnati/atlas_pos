import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportGroup, SalesReport, ZListItem } from '@shared/dto/backoffice'
import { Button, Card, Tabs, TextField } from '../../ui'
import { useQuery } from '../api'
import { PageHeader } from '../components/PageHeader'
import { today, useFormat } from '../format'

const GROUPS: ReportGroup[] = ['day', 'product', 'category', 'user', 'payment']

const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(y, m - 1, d + days)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${next.getFullYear()}-${two(next.getMonth() + 1)}-${two(next.getDate())}`
}

/** Takings over a period, by day, product, category, user or payment method; the Z history; Excel / CSV export. */
export function Reports() {
  const { t } = useTranslation()
  const f = useFormat()
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`)
  const [to, setTo] = useState(today())
  const [group, setGroup] = useState<ReportGroup>('day')
  const [view, setView] = useState<'report' | 'z'>('report')

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to
  const period = `from=${from}&to=${to}`
  const report = useQuery<SalesReport>(valid && view === 'report' ? `/api/reports?${period}&group=${group}` : null)
  const zList = useQuery<ZListItem[]>(valid && view === 'z' ? `/api/reports/z?${period}` : null)
  const data = report.data
  const exportLink = (format: 'xlsx' | 'csv') => `/api/reports/export?${period}&group=${group}&format=${format}`

  const columns = useMemo(() => {
    if (group === 'day') return ['date', 'day', 'z', 'tickets', 'gross', 'discounts', 'total'] as const
    if (group === 'product' || group === 'category') return ['label', 'qty', 'total'] as const
    if (group === 'user') return ['label', 'tickets', 'total'] as const
    return ['label', 'payments', 'total'] as const
  }, [group])

  const preset = (days: number) => {
    setTo(today())
    setFrom(addDays(today(), -days))
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.reports')} />
      <Card>
        <div className="cluster bo-period">
          <TextField label={t('bo.reports.from')} type="date" value={from} onChange={setFrom} data-testid="report-from" />
          <TextField label={t('bo.reports.to')} type="date" value={to} onChange={setTo} data-testid="report-to" />
          <Button variant="ghost" onClick={() => (setFrom(today()), setTo(today()))}>
            {t('bo.reports.today')}
          </Button>
          <Button variant="ghost" onClick={() => preset(6)}>
            {t('bo.reports.last7')}
          </Button>
          <Button variant="ghost" onClick={() => (setFrom(`${today().slice(0, 8)}01`), setTo(today()))}>
            {t('bo.reports.thisMonth')}
          </Button>
        </div>
        {!valid && <p className="error-text">{t('bo.reports.badPeriod')}</p>}
      </Card>
      <Tabs
        variant="segmented"
        value={view}
        onChange={setView}
        aria-label={t('bo.nav.reports')}
        tabs={[
          { id: 'report', label: t('bo.reports.sales') },
          { id: 'z', label: t('bo.reports.zHistory') }
        ]}
      />

      {view === 'report' && (
        <>
          <div className="cluster">
            <Tabs variant="underline" value={group} onChange={setGroup} aria-label={t('bo.reports.groupBy')} tabs={GROUPS.map((g) => ({ id: g, label: t(`bo.reports.group.${g}`) }))} />
            <span className="grow" />
            <a className="bo-link" href={valid ? exportLink('xlsx') : undefined} download data-testid="report-xlsx">
              {t('bo.reports.exportXlsx')}
            </a>
            <a className="bo-link" href={valid ? exportLink('csv') : undefined} download data-testid="report-csv">
              {t('bo.reports.exportCsv')}
            </a>
          </div>
          {data && (
            <div className="bo-cards">
              <Card className="bo-card">
                <h2 className="h3">{t('bo.reports.total')}</h2>
                <p className="bo-figure" data-testid="report-total">
                  {f.money(data.totals.totalCents)}
                </p>
                <p className="muted">{t('bo.reports.summary', { tickets: data.totals.ticketsCount, credits: data.totals.creditsCount, days: data.daysCount })}</p>
              </Card>
              <Card className="bo-card">
                <h2 className="h3">{t('bo.reports.group.payment')}</h2>
                <ul className="bo-list">
                  {data.totals.byPayment.map((p) => (
                    <li key={p.methodCode}>
                      <span>{f.name(p.name)}</span>
                      <span className="figure">{f.money(p.cents)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card className="bo-card">
                <h2 className="h3">{t('bo.reports.vat')}</h2>
                <ul className="bo-list">
                  {data.totals.byVat.map((v) => (
                    <li key={v.rateBp}>
                      <span>{f.vat(v.rateBp)}</span>
                      <span className="figure">{f.money(v.vat)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
          <div className="bo-table-wrap">
            <table className="bo-table" data-testid="report-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} className={c === 'label' || c === 'date' ? undefined : 'bo-num'}>
                      {t(`bo.reports.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((row) => (
                  <tr key={row.key}>
                    {columns.map((c) => {
                      switch (c) {
                        case 'date':
                          return (
                            <td key={c}>
                              {row.label.fr}
                              {row.open && <span className="bo-sub">{t('bo.reports.open')}</span>}
                            </td>
                          )
                        case 'label':
                          return <td key={c}>{f.name(row.label)}</td>
                        case 'day':
                          return <td key={c} className="bo-num">{row.dayNumber}</td>
                        case 'z':
                          return <td key={c} className="bo-num">{row.zNumber ?? '-'}</td>
                        case 'tickets':
                          return <td key={c} className="bo-num">{row.ticketsCount}</td>
                        case 'payments':
                          return <td key={c} className="bo-num">{row.count}</td>
                        case 'qty':
                          return <td key={c} className="bo-num">{f.qty(row.qtyMilli ?? 0)}</td>
                        case 'gross':
                          return <td key={c} className="bo-num figure">{f.money(row.grossCents ?? 0)}</td>
                        case 'discounts':
                          return <td key={c} className="bo-num figure">{f.money(row.discountsCents ?? 0)}</td>
                        default:
                          return <td key={c} className="bo-num figure">{f.money(row.totalCents)}</td>
                      }
                    })}
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length} className="muted bo-empty">
                      {t('bo.reports.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
              {data && data.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <th colSpan={columns.length - 1}>{t('bo.reports.total')}</th>
                    <th className="bo-num figure">{f.money(data.totals.totalCents)}</th>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      {view === 'z' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="z-table">
            <thead>
              <tr>
                <th className="bo-num">{t('bo.reports.col.z')}</th>
                <th>{t('bo.reports.col.date')}</th>
                <th className="bo-num">{t('bo.reports.col.tickets')}</th>
                <th className="bo-num">{t('bo.reports.col.gross')}</th>
                <th className="bo-num">{t('bo.reports.col.discounts')}</th>
                <th className="bo-num">{t('bo.reports.col.total')}</th>
              </tr>
            </thead>
            <tbody>
              {(zList.data ?? []).map((z) => (
                <tr key={z.id}>
                  <td className="bo-num">{z.number}</td>
                  <td>{f.dateTime(z.createdAt)}</td>
                  <td className="bo-num">{z.ticketsCount}</td>
                  <td className="bo-num figure">{f.money(z.grossCents)}</td>
                  <td className="bo-num figure">{f.money(z.discountsCents)}</td>
                  <td className="bo-num figure">{f.money(z.totalCents)}</td>
                </tr>
              ))}
              {zList.data && zList.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted bo-empty">
                    {t('bo.reports.empty')}
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
