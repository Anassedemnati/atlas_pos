/** A till PIN: 4 to 6 ASCII digits. */
export const isValidPin = (pin: string): boolean => /^[0-9]{4,6}$/.test(pin)

export const MIN_PASSWORD_LENGTH = 8
/**
 * Input caps, so that an absurd value is refused before it is hashed, stored or logged. Passwords
 * and the technician code share the first one; a login that exceeds a cap is answered like an unknown user.
 */
export const MAX_PASSWORD_LENGTH = 256
export const MAX_USERNAME_LENGTH = 64
/** The identifier of a back office client (its IP): longer values are cut, not refused. */
export const MAX_CLIENT_KEY_LENGTH = 128

/**
 * The form a username is stored and looked up in: trimmed, lower-case, 3 to 64 characters among
 * letters, digits and `. _ - @`. Returns null for text that is not a valid username.
 */
export function normalizeUsername(raw: string): string | null {
  if (raw.length > MAX_USERNAME_LENGTH * 2) return null // not worth trimming
  const name = raw.trim().toLowerCase()
  return /^[a-z0-9._@-]{3,64}$/.test(name) ? name : null
}

/** The letters on a PIN tile: the first letter of the first two words ("Sara El Idrissi" gives "SE"). */
export function initialsOf(displayName: string): string {
  const letters = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => Array.from(word)[0]!.toLocaleUpperCase())
  return letters.length > 0 ? letters.join('') : '?'
}
