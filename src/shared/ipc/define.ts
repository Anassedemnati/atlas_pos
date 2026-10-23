import { z } from 'zod'
import { PERMISSIONS, type Permission } from '../permissions'

/**
 * Who may call a channel, checked by the main process before the handler runs:
 * - `public`: anyone (the login screen, the start-up report);
 * - `session`: a user signed in on this window;
 * - `{ permission }`: a signed-in user holding it;
 * - `technician`: the technician code was entered on this window;
 * - `staff`: a signed-in user, or the technician mode (the technician menu works without a user);
 * - `handler`: the rule depends on the input or the start-up state, the handler checks it itself.
 */
export type ChannelAuth = 'public' | 'session' | 'technician' | 'staff' | 'handler' | { permission: Permission }

export interface ChannelDef<I extends z.ZodType = z.ZodType, O = unknown> {
  /** Validated in the main process; a failure is `invalid_input` and the handler never runs. */
  input: I
  auth: ChannelAuth
  /** Type only (never set): what a successful call returns. */
  readonly output?: O
}

/** `def<Out>()(inputSchema, auth)`: a channel whose successful result is `Out`. */
export const def =
  <O>() =>
  <I extends z.ZodType>(input: I, auth: ChannelAuth): ChannelDef<I, O> => ({ input, auth })

/** The input of a channel that takes nothing. */
export const none = z.strictObject({})

// Envelope rules. The use cases validate the business rules of what they receive (and answer
// `invalid_input` with the offending field); these only make sure the shape is right.
export const id = z.string().min(1).max(64)
export const text = z.string().max(2000)
export const int = z.number().int()
export const tokenId = id.optional()
export const bytes = z.instanceof(Uint8Array)
export const localizedName = z.strictObject({ fr: z.string(), ar: z.string().optional(), en: z.string().optional() })
export const discount = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pct'), bp: int, reason: text }),
  z.strictObject({ kind: z.literal('amount'), cents: int, reason: text })
])
export const permission = z.enum(PERMISSIONS)
