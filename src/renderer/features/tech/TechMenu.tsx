import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MODULES, type ModuleKey } from '@shared/modules'
import type { BackupEntryDto, LogLineDto, PrinterDto } from '@shared/dto'
import { errorMessage, invoke, useApi } from '../../app/api'
import { Button, ConfirmDialog, Keypad, Modal, Pill, Tabs, Toggle, useToast } from '../../ui'

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })

type TabId = 'modules' | 'hardware' | 'backups' | 'profile' | 'logs' | 'quit'

/**
 * The technician menu (long press on the logo, then the technician code): modules, hardware, backups, profile,
 * logs, and leaving to the desktop. It ends with the session (sign-out or auto-lock).
 */
export function TechMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [verified, setVerified] = useState(false)
  const [code, setCode] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const submit = async (value: string) => {
    setBusy(true)
    const result = await invoke('users.verifyTechnician', { code: value })
    setBusy(false)
    if (result.ok) return setVerified(true)
    setWrong(true)
    setCode('')
    toast.error(errorMessage(result.error))
  }

  if (!verified) {
    return (
      <Modal open onClose={onClose} title={t('tech.title')} size="sm">
        <div className="stack" style={{ alignItems: 'center' }} data-testid="tech-code">
          <p className="muted">{t('tech.enterCode')}</p>
          <Keypad mode="pin" maxLength={8} minLength={4} value={code} onChange={(v) => { setCode(v); setWrong(false) }} onEnter={(v) => void submit(v)} invalid={wrong} disabled={busy} captureKeys />
          {wrong && <p className="error-text" role="alert">{t('tech.wrongCode')}</p>}
        </div>
      </Modal>
    )
  }
  return <Menu onClose={onClose} />
}

function Menu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('modules')
  const tabs = (['modules', 'hardware', 'backups', 'profile', 'logs', 'quit'] as const).map((id) => ({ id, label: t(`tech.tabs.${id}`) }))
  return (
    <Modal open onClose={onClose} title={t('tech.title')} size="lg">
      <div className="stack" data-testid="tech-menu">
        <Tabs variant="underline" tabs={tabs} value={tab} onChange={setTab} aria-label={t('tech.title')} />
        {tab === 'modules' && <Modules />}
        {tab === 'hardware' && <Hardware />}
        {tab === 'backups' && <Backups />}
        {tab === 'profile' && <Profile />}
        {tab === 'logs' && <Logs />}
        {tab === 'quit' && <Quit />}
      </div>
    </Modal>
  )
}

function Modules() {
  const { t } = useTranslation()
  const api = useApi()
  const [modules, setModules] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    void invoke('settings.getAll', {}).then((result) => setModules(result.ok ? ((result.value['modules'] as Record<string, boolean>) ?? {}) : {}))
  }, [])
  const change = async (key: ModuleKey, on: boolean) => {
    const next = { ...(modules ?? {}), [key]: on } as Record<ModuleKey, boolean>
    const result = await api.call('tech.applyChanges', { patch: { modules: Object.fromEntries(MODULES.map((m) => [m, next[m] === true])) as Record<ModuleKey, boolean> } })
    if (result.ok) setModules(next)
  }
  if (!modules) return <p className="muted">{t('app.loading')}</p>
  return (
    <div className="stack">
      <p className="muted">{t('tech.modulesHint')}</p>
      {MODULES.map((key) => (
        <Toggle key={key} label={t(`tech.module.${key}`)} checked={modules[key] === true} onChange={(on) => void change(key, on)} />
      ))}
    </div>
  )
}

function Hardware() {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const [printers, setPrinters] = useState<PrinterDto[] | null>(null)
  useEffect(() => {
    void invoke('printing.printers', {}).then((result) => setPrinters(result.ok ? result.value : []))
  }, [])
  const test = async (printer: PrinterDto) => {
    const result = await api.call('hardware.testPrinter', { printerId: printer.id })
    if (result.ok) toast.success(t('tech.testSent', { name: printer.name }))
  }
  if (!printers) return <p className="muted">{t('app.loading')}</p>
  return (
    <ul className="plain-list" data-testid="tech-printers">
      {printers.map((printer) => (
        <li key={printer.id} className="job-row">
          <span className="grow">
            <strong>{printer.name}</strong>
            <span className="muted"> · {printer.kind} · {printer.role} · {printer.widthMm} mm</span>
          </span>
          <Pill tone={printer.active ? 'success' : 'neutral'}>{printer.active ? t('common.enabled') : t('common.disabled')}</Pill>
          <Button variant="secondary" icon="printer" onClick={() => void test(printer)}>
            {t('tech.testPage')}
          </Button>
        </li>
      ))}
      {printers.length === 0 && <p className="muted">{t('tech.noPrinters')}</p>}
    </ul>
  )
}

function Backups() {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const [list, setList] = useState<BackupEntryDto[] | null>(null)
  const [pick, setPick] = useState<BackupEntryDto | null>(null)
  const [busy, setBusy] = useState(false)
  const status = useStatus()
  const load = () => void invoke('backup.list', {}).then((result) => setList(result.ok ? result.value : []))
  useEffect(load, [])
  const run = async () => {
    setBusy(true)
    const result = await api.call('backup.run', {})
    setBusy(false)
    if (result.ok) {
      toast.success(t('tech.backupDone'))
      load()
    }
  }
  return (
    <div className="stack">
      <div className="cluster">
        <Pill tone={status === 'ok' ? 'success' : status === 'warning' ? 'warning' : status === 'error' ? 'danger' : 'neutral'} dot>
          {t(`status.backup.${status}`)}
        </Pill>
        <Button icon="disk" onClick={() => void run()} disabled={busy} data-testid="backup-run">
          {t('tech.backupNow')}
        </Button>
      </div>
      <ul className="plain-list" data-testid="tech-backups">
        {(list ?? []).map((entry) => (
          <li key={entry.file} className="job-row">
            <span className="grow">
              <strong>{dateTime.format(new Date(entry.createdAt))}</strong>
              <span className="muted"> · {entry.kind} · {entry.role}</span>
            </span>
            <Button variant="secondary" onClick={() => setPick(entry)}>
              {t('recovery.restore')}
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pick !== null}
        tone="danger"
        title={t('recovery.restoreTitle')}
        message={t('recovery.restoreMessage')}
        confirmLabel={t('recovery.restore')}
        onCancel={() => setPick(null)}
        onConfirm={() => {
          const entry = pick
          setPick(null)
          if (entry) void api.call('tech.restore', { file: entry.file })
        }}
      />
    </div>
  )
}

function useStatus(): 'ok' | 'pending' | 'warning' | 'error' {
  const [status, setStatus] = useState<'ok' | 'pending' | 'warning' | 'error'>('pending')
  useEffect(() => {
    void invoke('backup.status', {}).then((result) => result.ok && setStatus(result.value.overall === 'ok' && !result.value.lastOkAt ? 'pending' : result.value.overall))
  }, [])
  return status
}

function Profile() {
  const { t } = useTranslation()
  const api = useApi()
  const toast = useToast()
  const exportProfile = async () => {
    const result = await api.call('tech.exportProfile', {})
    if (!result.ok) return
    const blob = new Blob([result.value.bytes as BlobPart], { type: 'application/octet-stream' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = result.value.fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  }
  const importProfile = async () => {
    const picked = await api.call('system.pickFile', { title: t('tech.importProfile'), extensions: ['atlasprofile'] })
    if (!picked.ok || !picked.value) return
    const result = await api.call('tech.importProfile', { path: picked.value, replaceCatalog: false })
    if (result.ok) toast.success(t('tech.imported', { count: result.value.productsCreated }))
  }
  return (
    <div className="stack">
      <Button size="lg" icon="disk" onClick={() => void exportProfile()} data-testid="profile-export">
        {t('tech.exportProfile')}
      </Button>
      <Button size="lg" variant="secondary" icon="gear" onClick={() => void importProfile()}>
        {t('tech.importProfile')}
      </Button>
    </div>
  )
}

function Logs() {
  const { t } = useTranslation()
  const [lines, setLines] = useState<LogLineDto[] | null>(null)
  useEffect(() => {
    void invoke('tech.logs', { tail: 200 }).then((result) => setLines(result.ok ? result.value : []))
  }, [])
  if (!lines) return <p className="muted">{t('app.loading')}</p>
  return (
    <pre className="logs" data-testid="tech-logs">
      {lines.map((line) => `${line.time} ${line.level.toUpperCase()} ${line.event} ${Object.keys(line.data).length ? JSON.stringify(line.data) : ''}`).join('\n') || t('tech.noLogs')}
    </pre>
  )
}

function Quit() {
  const { t } = useTranslation()
  const [safe, setSafe] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    void invoke('app.startupReport', {}).then((result) => result.ok && setSafe(result.value.safeMode))
  }, [])
  return (
    <div className="stack">
      {safe && (
        <Button size="lg" block onClick={() => void invoke('app.restartNormally', {})} data-testid="restart-normally">
          {t('tech.restartNormally')}
        </Button>
      )}
      <Button size="lg" variant="danger" block icon="logout" onClick={() => setConfirm(true)} data-testid="quit-desktop">
        {t('tech.quitDesktop')}
      </Button>
      <ConfirmDialog open={confirm} tone="danger" title={t('tech.quitDesktop')} message={t('tech.quitMessage')} confirmLabel={t('tech.quitDesktop')} onCancel={() => setConfirm(false)} onConfirm={() => void invoke('tech.quitToDesktop', {})} />
    </div>
  )
}
