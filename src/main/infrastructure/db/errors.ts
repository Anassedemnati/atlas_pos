import type { AppError } from '@shared/result'

/** Why the database layer refused to start. Carries an `AppError` shape for the UI. */
export type DatabaseErrorCode = 'newer_schema' | 'wal_unavailable'

export class DatabaseError extends Error implements AppError {
  readonly code: DatabaseErrorCode
  readonly messageKey: string
  readonly params?: Record<string, unknown>

  constructor(code: DatabaseErrorCode, params?: Record<string, unknown>) {
    super(code)
    this.name = 'DatabaseError'
    this.code = code
    this.messageKey = `errors.${code}`
    if (params) this.params = params
  }
}
