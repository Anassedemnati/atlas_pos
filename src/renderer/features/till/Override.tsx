import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Permission } from '@shared/permissions'
import type { AppError, Result } from '@shared/result'
import { errorMessage, invoke } from '../../app/api'
import { Button, Keypad, Modal, useToast } from '../../ui'

/** The manager approvals collected for one action, by the permission each was given for. */
export type Tokens = Partial<Record<Permission, string>>

export interface GuardApi {
  /**
   * Runs an action that may need a manager. When the main process refuses it for that reason (a discount over the
   * limit, an offered line, a payment removed), a manager's PIN is asked and the action runs again with the approval.
   * Any other refusal is shown as a message. Cancelling the PIN prompt returns the first refusal without a message.
   */
  guard<T>(run: (tokens: Tokens) => Promise<Result<T>>): Promise<Result<T>>
}

const GuardContext = createContext<GuardApi>({ guard: (run) => run({}) })
export const useGuard = (): GuardApi => useContext(GuardContext)

const OVERRIDABLE: Permission[] = ['order.free_item', 'ticket.cancel', 'order.discount.override']

/** The permission a manager would have to approve, from a refusal; null when no approval can help. */
export function approvalNeeded(error: AppError): Permission | null {
  if (error.code === 'discount_over_limit') return 'order.discount.override'
  const permission = error.params?.['permission']
  if (error.code === 'forbidden' && typeof permission === 'string' && OVERRIDABLE.includes(permission as Permission)) return permission as Permission
  return null
}

/** The token to pass for an action that takes one (`overrideTokenId`): the first approval collected. */
export const firstToken = (tokens: Tokens): string | undefined => Object.values(tokens)[0]

interface Ask {
  permission: Permission
  resolve: (tokenId: string | null) => void
}

export function OverrideProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [pin, setPin] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef<Ask | null>(null)

  const askManager = useCallback(
    (permission: Permission) =>
      new Promise<string | null>((resolve) => {
        const next = { permission, resolve }
        pending.current = next
        setPin('')
        setWrong(false)
        setAsk(next)
      }),
    []
  )

  const close = (tokenId: string | null) => {
    pending.current?.resolve(tokenId)
    pending.current = null
    setAsk(null)
  }

  const submit = async (value: string) => {
    if (!ask || busy) return
    setBusy(true)
    const result = await invoke('users.authorizeOverride', { pin: value, permission: ask.permission })
    setBusy(false)
    if (result.ok) return close(result.value.id)
    setWrong(true)
    setPin('')
    toast.error(errorMessage(result.error))
  }

  const api = useMemo<GuardApi>(
    () => ({
      async guard<T>(run: (tokens: Tokens) => Promise<Result<T>>): Promise<Result<T>> {
        const tokens: Tokens = {}
        let result = await run(tokens)
        // At most two approvals for one action (an offered line can also exceed the discount limit).
        for (let round = 0; round < 2 && !result.ok; round++) {
          const needed = approvalNeeded(result.error)
          if (!needed || tokens[needed]) break
          const tokenId = await askManager(needed)
          if (!tokenId) return result
          tokens[needed] = tokenId
          result = await run(tokens)
        }
        if (!result.ok) toast.error(errorMessage(result.error))
        return result
      }
    }),
    [askManager, toast]
  )

  return (
    <GuardContext.Provider value={api}>
      {children}
      <Modal open={ask !== null} onClose={() => close(null)} title={t('till.override.title')} size="sm">
        <div className="stack" style={{ alignItems: 'center' }} data-testid="override-dialog">
          <p className="muted">{t('till.override.hint')}</p>
          <Keypad mode="pin" value={pin} onChange={(v) => { setPin(v); setWrong(false) }} onEnter={(v) => void submit(v)} invalid={wrong} captureKeys disabled={busy} />
          <Button variant="secondary" onClick={() => close(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      </Modal>
    </GuardContext.Provider>
  )
}
