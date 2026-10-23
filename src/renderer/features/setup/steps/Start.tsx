import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackupEntryDto } from '@shared/dto'
import { currentLanguage, setLanguage } from '../../../app/i18n'
import { Button, Card, ConfirmDialog, Icon, Modal, Pill, useToast, type IconName } from '../../../ui'
import { usePickers } from '../components/useFilePicker'
import { STEP_LANGUAGE } from '../steps-config'
import { useWizard } from '../wizard-context'

const dateTime = (iso: string, lang: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** Step 0: a new installation, a setup profile, or a backup to restore on this (new) computer. */
export function Start() {
  const { t } = useTranslation()
  const toast = useToast()
  const { api, adopt, goTo, busy } = useWizard()
  const { pickFile, pickFolder } = usePickers()
  const [working, setWorking] = useState(false)
  const [restore, setRestore] = useState<{ folder: string; entries: BackupEntryDto[] } | null>(null)
  const [chosen, setChosen] = useState<BackupEntryDto | null>(null)

  const startNew = async () => {
    setWorking(true)
    const lang = currentLanguage()
    const reset = await api.call('setup.resetDraft', {})
    if (reset.ok) {
      const saved = await api.call('setup.saveDraft', { patch: { startMode: 'new', step: STEP_LANGUAGE, lang: { setup: lang, receipt: lang, staffDefault: lang } } })
      if (saved.ok) adopt(saved.value)
    }
    setWorking(false)
  }

  const fromProfile = async () => {
    // No extension filter: `system.pickFile` accepts extensions of 8 characters at most, `atlasprofile` has 12.
    const path = await pickFile(t('setupWizard.start.profileTitle'))
    if (!path) return
    setWorking(true)
    const applied = await api.call('setup.applyProfile', { path })
    if (applied.ok) {
      adopt(applied.value)
      await setLanguage(applied.value.draft.lang.setup)
      await goTo(STEP_LANGUAGE)
    }
    setWorking(false)
  }

  const fromBackup = async () => {
    const folder = await pickFolder(t('setupWizard.start.restoreTitle'))
    if (!folder) return
    setWorking(true)
    const entries = await api.callValue('setup.listBackupsAt', { folder })
    setWorking(false)
    if (!entries) return
    if (entries.length === 0) toast.warning(t('setupWizard.start.noBackups'))
    else setRestore({ folder, entries })
  }

  const doRestore = async () => {
    if (!restore || !chosen) return
    setWorking(true)
    const result = await api.call('setup.restoreFrom', { file: chosen.file, folder: restore.folder })
    if (result.ok) await api.call('setup.openTill', {})
    setWorking(false)
    setChosen(null)
  }

  const choices: { icon: IconName; key: string; run: () => void }[] = [
    { icon: 'plus', key: 'new', run: () => void startNew() },
    { icon: 'gear', key: 'profile', run: () => void fromProfile() },
    { icon: 'disk', key: 'restore', run: () => void fromBackup() }
  ]

  return (
    <div className="wiz-start">
      <header className="wiz__head">
        <h1>{t('setupWizard.start.title')}</h1>
        <p className="muted wiz__lead">{t('setupWizard.start.lead')}</p>
      </header>
      <div className="wiz-start__grid">
        {choices.map((choice) => (
          <Card key={choice.key} onClick={choice.run} disabled={working || busy} className="wiz-choice" padding="lg" data-testid={`start-${choice.key}`}>
            <span className="wiz-choice__icon">
              <Icon name={choice.icon} size={48} />
            </span>
            <span className="wiz-choice__title">{t(`setupWizard.start.${choice.key}`)}</span>
            <span className="wiz-choice__text">{t(`setupWizard.start.${choice.key}Text`)}</span>
          </Card>
        ))}
      </div>

      <Modal open={restore !== null && chosen === null} onClose={() => setRestore(null)} title={t('setupWizard.start.pickBackup')} size="lg">
        <ul className="wiz-list">
          {restore?.entries.map((entry) => (
            <li key={entry.file}>
              <button type="button" className="wiz-list__row" onClick={() => setChosen(entry)}>
                <span className="wiz-list__main">
                  <strong>{dateTime(entry.createdAt, currentLanguage())}</strong>
                  <span className="muted">{entry.fileName}</span>
                </span>
                <Pill tone={entry.kind === 'full' ? 'teal' : 'neutral'}>{t(`setupWizard.start.kind.${entry.kind}`)}</Pill>
                <span className="muted">v{entry.appVersion}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
      <ConfirmDialog
        open={chosen !== null}
        title={t('setupWizard.start.restoreConfirmTitle')}
        message={t('setupWizard.start.restoreConfirm', { date: chosen ? dateTime(chosen.createdAt, currentLanguage()) : '' })}
        confirmLabel={t('setupWizard.start.restoreNow')}
        busy={working}
        onConfirm={() => void doRestore()}
        onCancel={() => setChosen(null)}
      />
    </div>
  )
}
