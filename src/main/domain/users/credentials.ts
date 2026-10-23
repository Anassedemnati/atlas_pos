/** A till PIN: 4 to 6 ASCII digits. */
export const isValidPin = (pin: string): boolean => /^[0-9]{4,6}$/.test(pin)

export const MIN_PASSWORD_LENGTH = 8
/** Not a security limit: it only keeps an absurd value from being hashed. */
export const MAX_PASSWORD_LENGTH = 200

/**
 * The form a username is stored and looked up in: trimmed, lower-case, 3 to 50 characters among
 * letters, digits and `. _ - @`. Returns null for text that is not a valid username.
 */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim().toLowerCase()
  return /^[a-z0-9._@-]{3,50}$/.test(name) ? name : null
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
