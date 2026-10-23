import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LoadedProfileDto, ParsedCatalogSheet, SetupDraftStateDto, SetupTemplateDto } from '@shared/dto'
import type { WizardDraft } from '@shared/setup/draft'
import { errorMessage, invoke, useApi } from '../../app/api'
import { LANGS, currentLanguage, setLanguage, type Lang } from '../../app/i18n'
import { Button, EmptyState, Stepper, Tabs, TopBar, useToast } from '../../ui'
import { fieldMessage } from './field-errors'
import { WizardContext, type DraftEdit, type WizardContextValue } from './wizard-context'
import {
  NUMBERED_STEPS,
  STEP_BACKUPS,
  STEP_BUSINESS,
  STEP_FIELDS,
  STEP_FINISH,
  STEP_KEYS,
  STEP_START,
  STEP_USERS,
  issueOf,
  localIssues,
  nextPatch
} from './steps-config'
import { Backups } from './steps/Backups'
import { Business } from './steps/Business'
import { Company } from './steps/Company'
import { Finish } from './steps/Finish'
import { Hardware } from './steps/Hardware'
import { Language } from './steps/Language'
import { Start } from './steps/Start'
import { Users } from './steps/Users'
import './wizard.css'

type Load = { status: 'loading' } | { status: 'ready' } | { status: 'done' } | { status: 'failed'; message: string }

const SCREENS: Record<number, () => JSX.Element> = {
  1: Language,
  2: Business,
  3: Company,
  4: Hardware,
  5: Users,
  6: Backups
}

/** The technician's first-run wizard: Start, the six numbered steps, then the summary. Resumes at the saved step. */
export function Wizard() {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [saved, setSaved] = useState<WizardDraft | null>(null)
  const [local, setLocal] = useState<Partial<WizardDraft>>({})
  const [profile, setProfile] = useState<LoadedProfileDto | null>(null)
  const [templates, setTemplates] = useState<SetupTemplateDto[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [importPreview, setImportPreview] = useState<ParsedCatalogSheet | null>(null)
  const [importName, setImportName] = useState('')
  const [techConfirm, setTechConfirm] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  const loadAll = useCallback(async () => {
    setLoad({ status: 'loading' })
    const [state, list] = await Promise.all([invoke('setup.getDraft', {}), invoke('setup.templates', {})])
    if (!state.ok) {
      // Setup already done (the page was reloaded after the end): nothing to configure.
      setLoad(state.error.code === 'forbidden' ? { status: 'done' } : { status: 'failed', message: errorMessage(state.error) })
      return
    }
    if (!list.ok) {
      setLoad({ status: 'failed', message: errorMessage(list.error) })
      return
    }
    setSaved(state.value.draft)
    setProfile(state.value.profile)
    setTemplates(list.value)
    setTechConfirm(state.value.draft.technicianCode)
    if (state.value.draft.lang.setup !== currentLanguage()) void setLanguage(state.value.draft.lang.setup)
    setLoad({ status: 'ready' })
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const merged = useMemo<WizardDraft | null>(() => (saved ? { ...saved, ...local } : null), [saved, local])
  const latest = useRef<WizardDraft | null>(merged)
  latest.current = merged

  const edit = useCallback((change: DraftEdit) => {
    if (!latest.current) return
    const patch = typeof change === 'function' ? change(latest.current) : change
    latest.current = { ...latest.current, ...patch }
    setLocal((previous) => ({ ...previous, ...patch }))
    const touched = Object.keys(patch)
    setErrors((previous) => {
      const keep = Object.entries(previous).filter(([field]) => !touched.some((key) => field === key || field.startsWith(`${key}.`)))
      return keep.length === Object.keys(previous).length ? previous : Object.fromEntries(keep)
    })
  }, [])

  const adopt = useCallback((state: SetupDraftStateDto, options?: { keepEdits?: boolean }) => {
    setSaved(state.draft)
    setProfile(state.profile)
    if (options?.keepEdits) return
    setLocal({})
    setErrors({})
  }, [])

  const toTop = () => scroller.current?.scrollTo({ top: 0 })

  const goTo = useCallback(
    async (step: number): Promise<boolean> => {
      setBusy(true)
      const result = await api.call('setup.saveDraft', { patch: { step } })
      setBusy(false)
      if (!result.ok) return false
      setSaved(result.value.draft)
      setProfile(result.value.profile)
      setErrors({})
      toTop()
      return true
    },
    [api]
  )

  const step = saved?.step ?? 0

  /** What stops "Suivant" before the main process is asked (state the main process cannot see). */
  const blockers = (): Record<string, string> => {
    if (!merged) return {}
    if (step === STEP_BUSINESS && merged.catalogSource === 'import') {
      if (importPreview && (importPreview.errors.length > 0 || importPreview.rows.length === 0)) return { importFile: t('setupWizard.business.importBlocked') }
      if (!importPreview && !saved?.importFile) return { importFile: t('setupWizard.business.importChoose') }
    }
    if (step === STEP_USERS && techConfirm !== merged.technicianCode) return { techConfirm: t('setupWizard.users.techMismatch') }
    return {}
  }

  const next = async () => {
    if (!merged || busy) return
    // What can be told without the main process: every missing field at once.
    const blocked = {
      ...Object.fromEntries(localIssues(step, merged).map((issue) => [issue.field, fieldMessage(issue)])),
      ...blockers()
    }
    if (Object.keys(blocked).length > 0) {
      setErrors(blocked)
      return
    }
    setBusy(true)
    const result = await api.call('setup.saveDraft', { patch: nextPatch(merged, step), validateStep: step }, { silent: true })
    setBusy(false)
    if (!result.ok) {
      // A field error shows beside its field and in the bar above the buttons (a field may be off screen).
      const issue = issueOf(result.error)
      if (issue) setErrors({ [issue.field]: fieldMessage(issue) })
      else toast.error(errorMessage(result.error))
      return
    }
    const sent = new Set<string>(STEP_FIELDS[step] ?? [])
    setSaved(result.value.draft)
    setProfile(result.value.profile)
    setLocal((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !sent.has(key))) as Partial<WizardDraft>)
    setErrors({})
    toTop()
  }

  // Bring the first error into view (the form may be taller than the screen).
  useEffect(() => {
    if (Object.keys(errors).length === 0) return
    const timer = setTimeout(() => scroller.current?.querySelector('.field--error, .wiz__error-anchor')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
    return () => clearTimeout(timer)
  }, [errors])

  if (load.status === 'loading') return <WizardFrame><EmptyState title={t('app.loading')} /></WizardFrame>
  if (load.status === 'failed') {
    return (
      <WizardFrame>
        <EmptyState icon="warning" title={load.message} action={<Button onClick={() => void loadAll()}>{t('common.retry')}</Button>} />
      </WizardFrame>
    )
  }
  if (load.status === 'done' || !saved || !merged) return <WizardFrame><Done /></WizardFrame>

  const value: WizardContextValue = {
    draft: merged,
    saved,
    profile,
    templates,
    api,
    edit,
    errors,
    setErrors,
    adopt,
    goTo,
    busy,
    importPreview,
    setImportPreview,
    importName,
    setImportName,
    techConfirm,
    setTechConfirm
  }

  const numbered = step >= 1 && step <= NUMBERED_STEPS
  const key = numbered ? STEP_KEYS[step - 1]! : null
  const Screen = SCREENS[step]
  const messages = [...new Set(Object.values(errors))].slice(0, 3)

  return (
    <WizardContext.Provider value={value}>
      <WizardFrame
        bar={
          step === STEP_START ? (
            <Tabs
              variant="bar"
              tabs={LANGS.map((id) => ({ id, label: t(`lang.${id}`) }))}
              value={currentLanguage()}
              onChange={(id: Lang) => {
                void setLanguage(id)
                edit((draft) => ({ lang: { ...draft.lang, setup: id } }))
              }}
              aria-label={t('common.language')}
            />
          ) : undefined
        }
        progress={numbered ? t('stepper.progress', { current: step, total: NUMBERED_STEPS }) : undefined}
      >
        {step !== STEP_START && (
          <aside className="wiz__side">
            <Stepper steps={STEP_KEYS.map((name) => t(`setupWizard.steps.${name}`))} current={step === STEP_FINISH ? NUMBERED_STEPS : step - 1} />
          </aside>
        )}
        <main className={`wiz__main${step === STEP_START ? ' wiz__main--wide' : ''}`}>
          <div className="wiz__scroll" ref={scroller}>
            <div className="wiz__content">
              {key && (
                <header className="wiz__head">
                  <h1>{t(`setupWizard.${key}.title`)}</h1>
                  <p className="muted wiz__lead">{t(`setupWizard.${key}.lead`)}</p>
                </header>
              )}
              {step === STEP_START && <Start />}
              {Screen && <Screen />}
              {step === STEP_FINISH && <Finish />}
            </div>
          </div>
          {numbered && (
            <footer className="wiz__footer">
              {messages.length > 0 && (
                <div className="wiz__alert" role="alert">
                  {messages.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              )}
              <div className="wiz__nav">
                <Button variant="secondary" size="lg" icon="back" onClick={() => void goTo(step - 1)} disabled={busy}>
                  {t('common.back')}
                </Button>
                <Button
                  size="lg"
                  className="wiz__next"
                  icon={step === STEP_BACKUPS ? 'check' : undefined}
                  iconEnd={step === STEP_BACKUPS ? undefined : 'next'}
                  onClick={() => void next()}
                  disabled={busy}
                >
                  {step === STEP_BACKUPS ? t('setupWizard.finishInstall') : t('common.next')}
                </Button>
              </div>
            </footer>
          )}
        </main>
      </WizardFrame>
    </WizardContext.Provider>
  )
}

function WizardFrame({ children, bar, progress }: { children: ReactNode; bar?: ReactNode; progress?: string }) {
  const { t } = useTranslation()
  return (
    <div className="page wiz">
      <TopBar title={t('setupWizard.title')} end={progress ? <span className="wiz__progress">{progress}</span> : undefined}>
        {bar}
      </TopBar>
      <div className="wiz__body">{children}</div>
    </div>
  )
}

/** The wizard opened after the installation was finished (a reload): the till is ready. */
function Done() {
  const { t } = useTranslation()
  const api = useApi()
  return (
    <EmptyState
      icon="check"
      title={t('setupWizard.alreadyDone')}
      action={
        <Button size="lg" onClick={() => void api.call('setup.openTill', {})}>
          {t('setupWizard.finish.start')}
        </Button>
      }
    />
  )
}
