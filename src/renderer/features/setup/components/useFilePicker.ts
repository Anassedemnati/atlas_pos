import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useWizard } from '../wizard-context'

/** The system "open" dialogs (`system.pickFile`, `system.pickFolder`): the path chosen, or null when cancelled. */
export function usePickers() {
  const { api } = useWizard()
  const { t } = useTranslation()
  const pickFile = useCallback(
    (title: string, extensions?: string[]) => api.callValue('system.pickFile', { title, ...(extensions ? { extensions } : {}) }),
    [api]
  )
  const pickFolder = useCallback((title?: string) => api.callValue('system.pickFolder', { title: title ?? t('setupWizard.pickFolder') }), [api, t])
  return { pickFile, pickFolder }
}
