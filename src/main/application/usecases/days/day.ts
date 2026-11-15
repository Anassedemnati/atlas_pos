import type { DayDto, DayGateDto } from '@shared/dto'
import { newId } from '@shared/ids'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { resetSequence } from '../../../infrastructure/db/sequences'
import type { Tx } from '../../../infrastructure/db/uow'
import type { Sales } from '../orders/context'

/** The café / snack counter number: 1 to 999, then 1 again; reset when a business day opens. */
export const ORDER_NUMBER_SEQUENCE = 'order-number'
export const ORDER_NUMBER_MAX = 999

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The first cut-over after `openedAt`, in local time (the till's clock is the shop's): the cut-over hour
 * of the opening date when the day opened before it (a day opened at 02:00 closes at 05:00), else the
 * one of the next date.
 */
export function cutoverAfter(openedAt: Date, cutoverHour: number): Date {
  const boundary = new Date(openedAt)
  boundary.setHours(cutoverHour, 0, 0, 0)
  if (boundary.getTime() <= openedAt.getTime()) {
    boundary.setDate(boundary.getDate() + 1)
    boundary.setHours(cutoverHour, 0, 0, 0)
  }
  return boundary
}

/**
 * `must_close` once the open day has lasted more than 24 h or reached its cut-over; `ok` otherwise, and
 * with no day open (`dayNumber` is then the one the next day will get, `openedAt` null).
 */
export function gateOf(day: DayDto | undefined, nextNumber: number, now: Date, cutoverHour: number): DayGateDto {
  if (!day) return { state: 'ok', dayNumber: nextNumber, openedAt: null }
  const opened = new Date(day.openedAt)
  const expired = now.getTime() - opened.getTime() > DAY_MS || now.getTime() >= cutoverAfter(opened, cutoverHour).getTime()
  return { state: expired ? 'must_close' : 'ok', dayNumber: day.number, openedAt: day.openedAt }
}

/**
 * The open business day, opened here when there is none (the first sale after a Z): number = last + 1,
 * and the counter of café order numbers starts again from 1. Runs inside the caller's transaction.
 */
export function ensureDay(tx: Tx, ctx: Sales, userId: string): DayDto {
  const open = ctx.days.openDay()
  if (open) return open
  const day: DayDto = {
    id: newId(),
    number: ctx.days.lastNumber() + 1,
    openedAt: tx.clock.now().toISOString(),
    closedAt: null
  }
  ctx.days.insert(tx, day)
  resetSequence(tx.db, ORDER_NUMBER_SEQUENCE)
  appendEvent(tx.db, { type: 'day.opened', entity: 'day', entityId: day.id, userId, data: { number: day.number } }, tx.clock)
  return day
}
