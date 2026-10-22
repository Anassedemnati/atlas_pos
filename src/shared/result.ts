export interface AppError {
  code: string
  messageKey: string
  params?: Record<string, unknown>
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }
