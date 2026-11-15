import type { AppError, Result } from '@shared/result'
import { AppErrorException } from '../../errors'

/** A refusal as the `Result` the UI receives; `params` is left out when there is none. */
export function refuse(code: string, params?: Record<string, unknown>): { ok: false; error: AppError } {
  return { ok: false, error: { code, messageKey: `errors.${code}`, ...(params ? { params } : {}) } }
}

const toRefusal = (error: unknown): { ok: false; error: AppError } => {
  if (error instanceof AppErrorException) return refuse(error.code, error.params)
  throw error
}

/**
 * Runs a use case that reports its refusals by throwing `AppErrorException` (a transaction that
 * must roll back, `requirePermission`) and turns them into a `Result`. Anything else is a bug and
 * keeps propagating.
 */
export async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return toRefusal(error)
  }
}

export function attemptSync<T>(run: () => T): Result<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return toRefusal(error)
  }
}

/** An `invalid_input` refusal: `params.field` names the offending input (a dotted path for nested values). */
export function invalidInput(field: string, reason?: string): AppErrorException {
  return new AppErrorException('invalid_input', { field, ...(reason ? { reason } : {}) })
}
