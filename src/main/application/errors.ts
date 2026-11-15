import type { AppError } from '@shared/result'

/**
 * A failure a use case reports on purpose (invalid input, refused action). It carries the
 * `AppError` shape the UI renders: `messageKey` is the i18n key `errors.<code>`, and `params`
 * fill its placeholders (or name the offending `field`).
 */
export class AppErrorException extends Error implements AppError {
  readonly code: string
  readonly messageKey: string
  readonly params?: Record<string, unknown>

  constructor(code: string, params?: Record<string, unknown>) {
    super(code)
    this.name = 'AppErrorException'
    this.code = code
    this.messageKey = `errors.${code}`
    if (params) this.params = params
  }
}
