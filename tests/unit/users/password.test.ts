import { describe, expect, it, vi } from 'vitest'
import {
  hashSecret,
  hashSecretAsync,
  verifySecret,
  verifySecretAsync
} from '../../../src/main/infrastructure/security/password'

// Each hash costs ~100 ms: a loaded machine must not turn that into a timeout.
vi.setConfig({ testTimeout: 30_000 })

describe('hashSecret / verifySecret', () => {
  const hash = hashSecret('1234')

  it('writes scrypt$N$r$p$salt$hash with N=2^15, r=8, p=1 and a 16-byte salt', () => {
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/)
    const [, , , , salt] = hash.split('$')
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16)
  })

  it('verifies the right secret and refuses a wrong one', () => {
    expect(verifySecret('1234', hash)).toBe(true)
    expect(verifySecret('1235', hash)).toBe(false)
    expect(verifySecret('', hash)).toBe(false)
  })

  it('salts every hash, so the same secret never hashes twice to the same text', () => {
    const other = hashSecret('1234')
    expect(other).not.toBe(hash)
    expect(verifySecret('1234', other)).toBe(true)
  })

  it('answers false, and never throws, for a stored value that is not a valid hash', () => {
    const [, n, r, p, salt, key] = hash.split('$') as [string, string, string, string, string, string]
    const bad = [
      '',
      'not a hash',
      'scrypt$1$2',
      `bcrypt$${n}$${r}$${p}$${salt}$${key}`,
      `scrypt$${n}$${r}$${p}$${salt}$`,
      `scrypt$${n}$${r}$${p}$$${key}`,
      `scrypt$abc$${r}$${p}$${salt}$${key}`,
      `scrypt$${n}$${r}$${p}$${salt}$${key}$extra`,
      // Parameters that would ask for gigabytes of memory, or that scrypt itself refuses.
      `scrypt$${2 ** 30}$8$1$${salt}$${key}`,
      `scrypt$32767$8$1$${salt}$${key}`,
      `scrypt$${n}$${r}$0$${salt}$${key}`
    ]
    for (const stored of bad) expect(verifySecret('1234', stored), stored).toBe(false)
  })

  it('has async variants that read and write the same format', async () => {
    const asyncHash = await hashSecretAsync('Atlas-Secret-2026')
    expect(asyncHash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(verifySecret('Atlas-Secret-2026', asyncHash)).toBe(true)
    expect(await verifySecretAsync('Atlas-Secret-2026', asyncHash)).toBe(true)
    expect(await verifySecretAsync('nope', asyncHash)).toBe(false)
    expect(await verifySecretAsync('1234', hash)).toBe(true)
    expect(await verifySecretAsync('1234', 'garbage')).toBe(false)
  })
})
