import { useTranslation } from 'react-i18next'
import type { ZData } from '@shared/dto'
import { useFormat } from '../till/format'

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

/** The figures of an X or a Z report. */
export function ZReportView({ data }: { data: ZData }) {
  const { t } = useTranslation()
  const { money, name } = useFormat()
  return (
    <div className="zview" data-testid="z-view">
      <div className="zview__head">
        <h3 className="h3">{data.zNumber === null ? t('closure.xTitle') : t('closure.zTitle', { number: data.zNumber })}</h3>
        <span className="muted">
          {t('closure.day', { number: data.dayNumber })} · {dateTime.format(new Date(data.openedAt))}
          {data.closedAt && ` → ${dateTime.format(new Date(data.closedAt))}`}
        </span>
      </div>
      <div className="zview__total">
        <span>{t('closure.xTotal')}</span>
        <strong className="figure" data-testid="z-total">{money(data.totalCents)}</strong>
      </div>
      <dl className="zview__grid">
        <dt>{t('closure.ticketsLabel')}</dt>
        <dd className="figure">{data.ticketsCount}</dd>
        <dt>{t('closure.credits')}</dt>
        <dd className="figure">{data.creditsCount}</dd>
        <dt>{t('closure.gross')}</dt>
        <dd className="figure">{money(data.grossCents)}</dd>
        <dt>{t('closure.discounts')}</dt>
        <dd className="figure">-{money(data.discountsCents)}</dd>
        <dt>{t('closure.freeItems')}</dt>
        <dd className="figure">
          {data.freeItems.count} · {money(data.freeItems.cents)}
        </dd>
        <dt>{t('closure.voids')}</dt>
        <dd className="figure">
          {data.voids.count} · {money(data.voids.cents)}
        </dd>
        <dt>{t('closure.reprints')}</dt>
        <dd className="figure">{data.reprints}</dd>
      </dl>
      <Section title={t('closure.byPayment')}>
        {data.byPayment.map((row) => (
          <Row key={row.methodCode} left={`${name(row.name)} (${row.count})`} right={money(row.cents)} />
        ))}
      </Section>
      <Section title={t('closure.byVat')}>
        {data.byVat.map((row) => (
          <Row key={row.rateBp} left={`${row.rateBp / 100} %`} right={`${money(row.ht)} + ${money(row.vat)}`} />
        ))}
      </Section>
      <Section title={t('closure.byUser')}>
        {data.byUser.map((row) => (
          <Row key={row.userId} left={`${row.displayName} (${row.ticketsCount})`} right={money(row.cents)} />
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="zview__section">
      <h4>{title}</h4>
      {children}
    </section>
  )
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="zview__row">
      <span>{left}</span>
      <span className="figure">{right}</span>
    </div>
  )
}
