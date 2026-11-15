import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppError } from '@shared/result'
import { errorMessage } from '../../../app/api'
import { Button, Card, Icon, Pill } from '../../../ui'
import { Banner } from '../components/Banner'
import { STEP_BACKUPS, issueOf, stepOfField } from '../steps-config'
import { useWizard } from '../wizard-context'

type State = { phase: 'running' } | { phase: 'done'; warnings: string[] } | { phase: 'failed'; error: AppError }

/** The order the main process goes through (`params.stage` of a failure names one of them). */
const STAGES = ['database', 'seed', 'installation', 'open'] as const

/** Step 7: creates the installation (database, catalogue, first backup), then hands the till over to the login. */
export function Finish() {
  const { t } = useTranslation()
  const { api, goTo } = useWizard()
  const [state, setState] = useState<State>({ phase: 'running' })
  const [opening, setOpening] = useState(false)
  const started = useRef(false)

  const run = useCallback(async () => {
    setState({ phase: 'running' })
    const result = await api.call('setup.finish', {}, { silent: true })
    setState(result.ok ? { phase: 'done', warnings: result.value.warnings } : { phase: 'failed', error: result.error })
  }, [api])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
  }, [run])

  const start = async () => {
    setOpening(true)
    const result = await api.call('setup.openTill', {})
    if (!result.ok) setOpening(false)
  }

  const failedStage = state.phase === 'failed' ? (state.error.params?.['stage'] as string | undefined) : undefined
  const failedIndex = failedStage ? STAGES.indexOf(failedStage as (typeof STAGES)[number]) : -1
  const issue = state.phase === 'failed' ? issueOf(state.error) : null
  const fixStep = issue ? stepOfField(issue.field) : null

  const warningText = (warning: string): string => {
    if (warning.startsWith('backup_target:')) return t('setupWizard.finish.warn.backup_target', { detail: warning.split(':').slice(2).join(':') })
    return t(`setupWizard.finish.warn.${warning}`, { defaultValue: warning })
  }

  return (
    <div className="stack wiz-stack wiz-finish">
      <header className="wiz__head">
        <h1>{t(state.phase === 'done' ? 'setupWizard.finish.doneTitle' : state.phase === 'failed' ? 'setupWizard.finish.failedTitle' : 'setupWizard.finish.title')}</h1>
        <p className="muted wiz__lead">{t(state.phase === 'done' ? 'setupWizard.finish.doneLead' : state.phase === 'failed' ? 'setupWizard.finish.failedLead' : 'setupWizard.finish.lead')}</p>
      </header>

      <Card className="wiz-progress" aria-live="polite">
        <ul>
          {STAGES.map((stage, index) => {
            const tone = state.phase === 'done' ? 'done' : state.phase === 'failed' ? (failedIndex < 0 ? 'todo' : index < failedIndex ? 'done' : index === failedIndex ? 'failed' : 'todo') : 'running'
            return (
              <li key={stage} className={`wiz-progress__item wiz-progress__item--${tone}`} data-state={tone}>
                <span className="wiz-progress__mark" aria-hidden="true">
                  {tone === 'done' && <Icon name="check" size={26} strokeWidth={3} />}
                  {tone === 'failed' && <Icon name="close" size={26} strokeWidth={3} />}
                  {tone === 'running' && <span className="wiz-spinner" />}
                </span>
                <span>{t(`setupWizard.finish.stages.${stage}`)}</span>
              </li>
            )
          })}
        </ul>
      </Card>

      {state.phase === 'failed' && (
        <>
          <Banner tone="warning">
            <span data-testid="finish-error">{errorMessage(state.error)}</span>
          </Banner>
          <div className="cluster">
            <Button size="lg" onClick={() => void run()}>
              {t('common.retry')}
            </Button>
            <Button size="lg" variant="secondary" icon="back" onClick={() => void goTo(fixStep ?? STEP_BACKUPS)}>
              {fixStep ? t('setupWizard.finish.fix') : t('common.back')}
            </Button>
          </div>
        </>
      )}

      {state.phase === 'done' && (
        <>
          {state.warnings.length > 0 && (
            <Banner tone="warning">
              <p className="wiz-banner__title">{t('setupWizard.finish.warnings')}</p>
              <ul className="wiz-issues">
                {state.warnings.map((warning) => (
                  <li key={warning}>{warningText(warning)}</li>
                ))}
              </ul>
            </Banner>
          )}
          {state.warnings.length === 0 && (
            <Pill tone="success" icon="check">
              {t('setupWizard.finish.allGood')}
            </Pill>
          )}
          <div>
            <Button size="xl" iconEnd="next" onClick={() => void start()} disabled={opening} data-testid="finish-start">
              {t('setupWizard.finish.start')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
