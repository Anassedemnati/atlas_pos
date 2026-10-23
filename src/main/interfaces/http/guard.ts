import { isIPv4, isIPv6 } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { refuse } from '../../application/usecases/users/outcome'

/** An IPv4 address as four numbers, or null. */
function octets(ip: string): [number, number, number, number] | null {
  if (!isIPv4(ip)) return null
  const parts = ip.split('.').map(Number)
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

function privateV4([a, b]: [number, number, number, number]): boolean {
  return (
    a === 127 || // loopback 127/8
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) // link-local 169.254/16
  )
}

/**
 * True for the addresses of a local network: loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, and the IPv6
 * `::1`, `fc00::/7` (unique local), `fe80::/10` (link-local), plus an IPv4 address written as `::ffff:a.b.c.d`.
 * Anything else (a public address, text that is no address) is not.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false
  const ip = address.split('%')[0]!.toLowerCase() // an IPv6 zone id (`fe80::1%en0`) is not part of the address
  const v4 = octets(ip)
  if (v4) return privateV4(v4)
  if (!isIPv6(ip)) return false
  if (ip === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) {
    const inner = octets(mapped[1]!)
    return inner ? privateV4(inner) : false
  }
  const first = ip.split(':')[0] ?? ''
  if (first === '') return false // `::...` other than ::1 (unspecified, IPv4-compatible)
  const hextet = Number.parseInt(first, 16)
  return (hextet & 0xfe00) === 0xfc00 || (hextet & 0xffc0) === 0xfe80
}

/** The text of a client address as it is logged and used as the login rate-limit key (IPv4-mapped addresses written as IPv4). */
export function clientKey(address: string | undefined): string {
  const ip = (address ?? 'unknown').split('%')[0]!
  return ip.toLowerCase().startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip
}

/** What every response carries. The page loads its own files only; it can neither be framed nor load a foreign script. */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
}

/**
 * The two rules that apply to every request, the static files and the 404s included:
 * - a client outside the local network is answered 403 before anything else runs (the socket's address, never a header);
 * - security headers on every response, and no caching of the API.
 */
export function registerGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isPrivateAddress(request.ip)) return
    return reply.code(403).send(refuse('forbidden', { reason: 'not_lan' }))
  })
  app.addHook('onSend', async (request, reply, payload) => {
    // A response that set its own (the media files carry a stricter policy) keeps it.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(name)) void reply.header(name, value)
    if (request.url.startsWith('/api/')) void reply.header('cache-control', 'no-store')
    return payload
  })
}
