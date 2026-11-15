import { describe, expect, it } from 'vitest'
import type { AppError, Result } from '@shared/result'

function half(n: number): Result<number> {
  if (n % 2 !== 0) {
    const error: AppError = { code: 'ODD', messageKey: 'errors.odd', params: { n } }
    return { ok: false, error }
  }
  return { ok: true, value: n / 2 }
}

describe('Result', () => {
  it('narrows to the value on success', () => {
    const r = half(8)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value).toBe(4)
  })

  it('narrows to the error on failure', () => {
    const r = half(7)
    if (r.ok) throw new Error('expected error')
    expect(r.error).toEqual({ code: 'ODD', messageKey: 'errors.odd', params: { n: 7 } })
  })
})
