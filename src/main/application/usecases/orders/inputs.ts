import { z } from 'zod'
import { invalidInput } from '../users/outcome'

const id = z.string().min(1).max(64)
const reason = z.string().trim().min(1).max(200)
const note = z.string().trim().max(500)

export const OpenOrderSchema = z.strictObject({
  type: z.enum(['dine_in', 'takeaway', 'delivery', 'counter']),
  tableId: id.optional(),
  covers: z.number().int().min(0).max(999).optional(),
  customerId: id.optional()
})
export type OpenOrderInput = z.input<typeof OpenOrderSchema>

export const AddLineSchema = z.strictObject({
  productId: id,
  /** Thousandths: 1 item = 1000; a product sold by weight takes any whole number of grams. */
  qtyMilli: z.number(),
  modifierIds: z.array(id).max(50).default([]),
  note: note.default(''),
  /** For a set menu: the products chosen in each of its courses. */
  menuChoices: z.array(z.strictObject({ courseId: id, productIds: z.array(id).max(20) })).max(20).optional()
})
export type AddLineInput = z.input<typeof AddLineSchema>

export const DiscountSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pct'), bp: z.number().int().min(0).max(10000), reason }),
  z.strictObject({ kind: z.literal('amount'), cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), reason })
])

/** A reason (void, discount, free item, cancellation): trimmed, required; `invalid_input` on field `reason` otherwise. */
export function reasonOf(raw: unknown): string {
  const parsed = reason.safeParse(raw)
  if (!parsed.success) throw invalidInput('reason', 'required')
  return parsed.data
}

export const NoteSchema = note
export const IdSchema = id
export const CoversSchema = z.number().int().min(0).max(999)

export const PaymentSchema = z.strictObject({
  methodCode: z.string().min(1).max(32),
  amountCents: z.number(),
  tenderedCents: z.number().optional()
})
export type AddPaymentInput = z.input<typeof PaymentSchema>

/** Bill by items: the lines of each part and what pays it. */
export const SplitGroupsSchema = z
  .array(z.strictObject({ lineIds: z.array(id).max(500), payments: z.array(z.unknown()).max(20) }))
  .min(1)
  .max(50)
