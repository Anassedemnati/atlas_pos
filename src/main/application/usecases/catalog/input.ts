import type { z } from 'zod'
import type { Session } from '../../../domain/users/session'
import { appendEvent, type EventInput } from '../../../infrastructure/db/event-log'
import type { Tx } from '../../../infrastructure/db/uow'
import { invalidInput } from '../users/outcome'

/** The offending field of a zod failure: a dotted path (`courses.0.items.1.productId`), or the unknown key itself. */
export function fieldOf(issue: z.core.$ZodIssue, prefix: (string | number)[] = []): string {
  const path = [...prefix, ...issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment))]
  if (issue.code === 'unrecognized_keys') path.push(issue.keys[0] ?? '')
  return path.join('.')
}

/** Validates what a caller sent, or throws `invalid_input` naming the first offending field. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw invalidInput(issue ? fieldOf(issue) : '', issue?.message)
}

/** Writes the audit row of a change and announces `catalog.changed` once the transaction commits. */
export function logChange(tx: Tx, session: Session, event: Omit<EventInput, 'userId'>): void {
  appendEvent(tx.db, { ...event, userId: session.userId }, tx.clock)
  tx.events.push({ type: 'catalog.changed' })
}
