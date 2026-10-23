import { invalidInput } from '../users/outcome'

/** A calendar date as the pickers write it: `2026-10-23`. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The longest period a report covers: one leap year. */
export const MAX_REPORT_DAYS = 366

export interface Period {
  /** `YYYY-MM-DD`, the first day (inclusive). */
  from: string
  /** `YYYY-MM-DD`, the last day (inclusive). */
  to: string
  /** The instant the first day starts, local time (ISO, UTC). */
  startIso: string
  /** The instant the day after the last one starts (ISO, UTC): `opened_at < endIso`. */
  endIso: string
}

function localMidnight(text: string, field: string): Date {
  const match = DATE.exec(text)
  if (!match) throw invalidInput(field, 'expected YYYY-MM-DD')
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  // `new Date(2026, 1, 31)` rolls over to March: the text must name a real day.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw invalidInput(field, 'not a calendar day')
  return date
}

/**
 * The period of a report. A business day belongs to the calendar day it was opened on (local time), so a
 * day opened at 23:00 and closed by the Z the next morning is the first one's: the same rule as the Z numbers.
 */
export function parsePeriod(from: string, to: string): Period {
  const start = localMidnight(from, 'from')
  const last = localMidnight(to, 'to')
  if (last < start) throw invalidInput('to', 'before the start')
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  if (days > MAX_REPORT_DAYS) throw invalidInput('to', 'period too long')
  return { from, to, startIso: start.toISOString(), endIso: end.toISOString() }
}

/** Today as `YYYY-MM-DD`, local time. */
export function localDate(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}
