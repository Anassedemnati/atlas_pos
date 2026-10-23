import { z } from 'zod'
import { PERMISSIONS, type Permission } from '@shared/permissions'

/** A profile is a manager's when it holds every permission: the last such active user must always remain. */
export function isManagerPermissions(permissions: readonly Permission[]): boolean {
  const held = new Set(permissions)
  return PERMISSIONS.every((p) => held.has(p))
}

const knownPermissions: ReadonlySet<string> = new Set(PERMISSIONS)

/** The permissions stored in `profiles.permissions_json`. A row that cannot be read grants nothing. */
export function parsePermissions(json: string): Permission[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((p): p is Permission => typeof p === 'string' && knownPermissions.has(p))
}

const text = z.string().trim().min(1).max(60)

export const ProfileInputSchema = z.strictObject({
  /** Absent to create a profile. */
  id: z.string().min(1).optional(),
  /** French is the reference copy and always present. */
  name: z.strictObject({ fr: text, ar: text.optional(), en: text.optional() }),
  permissions: z
    .array(z.enum(PERMISSIONS))
    .refine((list) => new Set(list).size === list.length, { message: 'duplicate permission' }),
  /** Basis points: 1000 = 10 %. */
  maxDiscountBp: z.number().int().min(0).max(10000)
})

export type ProfileInput = z.input<typeof ProfileInputSchema>
