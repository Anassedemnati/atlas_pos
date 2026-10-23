import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto'

// One format for every secret the app stores (till PINs, back office passwords, the technician
// code): `scrypt$N$r$p$salt$hash`, with salt and hash in base64.
const N = 2 ** 15
const R = 8
const P = 1
const SALT_BYTES = 16
const KEY_BYTES = 64

// What `verifySecret` accepts from storage. A stored value is data, not trusted: parameters that
// would make scrypt allocate gigabytes, or a key of absurd length, are a refusal, not a crash.
const MIN_N = 2 ** 10
const MAX_N = 2 ** 16
const MAX_R = 16
const MAX_P = 4
const MIN_KEY_BYTES = 16
const MAX_KEY_BYTES = 128
const MAX_SALT_BYTES = 64

interface Parsed {
  salt: Buffer
  key: Buffer
  options: ScryptOptions
}

/**
 * scrypt needs `128 * N * r` bytes and Node refuses anything above its 32 MiB default `maxmem`.
 * N=2^15, r=8 needs exactly 32 MiB, so every call must raise the limit.
 */
const maxmemFor = (n: number, r: number): number => 128 * n * r * 2

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0

// Canonical base64 only: Buffer.from() would silently skip the characters it does not know.
const decodeBase64 = (text: string): Buffer | null => {
  const bytes = Buffer.from(text, 'base64')
  return bytes.length > 0 && bytes.toString('base64') === text ? bytes : null
}

const toInt = (text: string): number => (/^[0-9]{1,10}$/.test(text) ? Number(text) : NaN)

function parse(stored: string): Parsed | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const n = toInt(parts[1]!)
  const r = toInt(parts[2]!)
  const p = toInt(parts[3]!)
  if (!isPowerOfTwo(n) || n < MIN_N || n > MAX_N) return null
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null
  const salt = decodeBase64(parts[4]!)
  const key = decodeBase64(parts[5]!)
  if (!salt || salt.length > MAX_SALT_BYTES || !key || key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) return null
  return { salt, key, options: { N: n, r, p, maxmem: maxmemFor(n, r) } }
}

const options: ScryptOptions = { N, r: R, p: P, maxmem: maxmemFor(N, R) }

const format = (salt: Buffer, key: Buffer): string =>
  `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`

const scryptAsync = (secret: string, salt: Buffer, keyBytes: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(secret, salt, keyBytes, opts, (error, key) => (error ? reject(error) : resolve(key)))
  })

/**
 * Hashes a secret with a fresh random salt. This blocks the thread for ~100 ms: use it in tests and
 * seeds, and `hashSecretAsync` on any path a person is waiting on (the Electron main thread).
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES)
  return format(salt, scryptSync(secret, salt, KEY_BYTES, options))
}

export async function hashSecretAsync(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  return format(salt, await scryptAsync(secret, salt, KEY_BYTES, options))
}

/** True when `secret` is the one `stored` was made from. False for a wrong secret and for a value that is not a valid hash. Blocks ~100 ms. */
export function verifySecret(secret: string, stored: string): boolean {
  const parsed = parse(stored)
  if (!parsed) return false
  try {
    return timingSafeEqual(scryptSync(secret, parsed.salt, parsed.key.length, parsed.options), parsed.key)
  } catch {
    return false
  }
}

/** `verifySecret` on the thread pool, so the main thread keeps serving the till meanwhile. */
export async function verifySecretAsync(secret: string, stored: string): Promise<boolean> {
  const parsed = parse(stored)
  if (!parsed) return false
  try {
    return timingSafeEqual(await scryptAsync(secret, parsed.salt, parsed.key.length, parsed.options), parsed.key)
  } catch {
    return false
  }
}

let decoyHash: Promise<string> | undefined

/**
 * Spends the time of one verification on nothing: answered for a user that does not exist, so that
 * "unknown user" and "wrong secret" cannot be told apart by how long the answer takes.
 */
export async function verifyAgainstDecoy(secret: string): Promise<void> {
  decoyHash ??= hashSecretAsync(randomBytes(16).toString('hex'))
  await verifySecretAsync(secret, await decoyHash)
}
