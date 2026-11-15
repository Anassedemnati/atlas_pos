/** Touch target heights in px. Mirrors `--touch-*` in theme/tokens.css (a unit test keeps them equal). */
export const TOUCH = { md: 64, lg: 72, xl: 88 } as const

export type ControlSize = keyof typeof TOUCH

/** Joins class names, skipping the falsy ones. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')
