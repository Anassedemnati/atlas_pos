import type { FastifyInstance } from 'fastify'
import { AppErrorException } from '../../../application/errors'
import { SETTING_KEYS, SETTINGS, isSettingKey, type SettingKey } from '../../../domain/config/settings-registry'
import { requirePermission } from '../../../domain/users/session'
import { acting, call, ok, route, type Env } from './shared'

/** Never read or written here: the technician code has its own use cases. */
const SECRET: SettingKey = 'tech.codeHash'

/** The settings only the technician may change (VAT rates, kiosk, back office port...): shown, never editable over HTTP. */
const TECHNICIAN_ONLY = SETTING_KEYS.filter((key) => SETTINGS[key].permission === 'technician')

/** The business identity, the receipt, the interface options. */
export function registerSettingsRoutes(app: FastifyInstance, env: Env): void {
  app.get(
    '/api/settings',
    route(env, async (request) => {
      const values = await call(env, request, 'settings.getAll', {})
      return values.ok ? ok({ values: values.value, technicianOnly: TECHNICIAN_ONLY.filter((key) => key !== SECRET) }) : values
    })
  )

  /**
   * `{ changes: { 'receipt.footer': '...', ... } }`, all or nothing: every key is checked (known, not the secret, within
   * the rights of the user, valid) and then written in one transaction, so a refused value changes none of them.
   */
  app.put(
    '/api/settings',
    route(env, (request) => {
      const { services, session } = acting(env, request)
      const changes = (request.body as { changes?: unknown } | null)?.changes
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new AppErrorException('invalid_input', { field: 'changes' })
      const entries = Object.entries(changes as Record<string, unknown>)
      if (entries.length === 0 || entries.length > 40) throw new AppErrorException('invalid_input', { field: 'changes' })
      for (const [key] of entries) {
        if (!isSettingKey(key) || key === SECRET) throw new AppErrorException('invalid_input', { field: key })
        const rule = SETTINGS[key].permission
        // No technician mode over HTTP.
        if (rule === 'technician') throw new AppErrorException('forbidden', { reason: 'technician', key })
        requirePermission(session, rule)
      }
      services.uow.run((tx) => {
        // The repo validates each value against the registry (`invalid_input`, `params.field`); a throw rolls everything back.
        for (const [key, value] of entries) services.settings.set(tx, key as SettingKey, value as never, session.userId)
      })
      return ok(true as const)
    })
  )
}
