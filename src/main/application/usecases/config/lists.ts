import type { CategoryRouteDto, FloorDto, PaymentMethodDto, StaffDto } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { Database } from '../../../infrastructure/db/connection'
import { createUsersRepo } from '../../../infrastructure/db/repos/users-repo'

const nameOf = (json: string, fallback: string): LocalizedName => {
  try {
    const parsed = JSON.parse(json) as Partial<LocalizedName> | null
    if (parsed && typeof parsed.fr === 'string') {
      return { fr: parsed.fr, ...(parsed.ar ? { ar: parsed.ar } : {}), ...(parsed.en ? { en: parsed.en } : {}) }
    }
  } catch {
    // falls through
  }
  return { fr: fallback }
}

interface RoomRow {
  id: string
  name_json: string
  sort: number
}
interface TableRow {
  id: string
  room_id: string
  label: string
  shape: 'square' | 'round' | 'rect'
  x: number
  y: number
  w: number
  h: number
  seats: number
  active: number
}

export function listFloor(db: Database): FloorDto {
  return {
    rooms: (db.prepare('SELECT * FROM rooms ORDER BY sort, id').all() as RoomRow[]).map((r) => ({ id: r.id, name: nameOf(r.name_json, r.id), sort: r.sort })),
    tables: (db.prepare('SELECT t.* FROM tables t JOIN rooms r ON r.id = t.room_id ORDER BY r.sort, r.id, t.id').all() as TableRow[]).map((t) => ({
      id: t.id,
      roomId: t.room_id,
      label: t.label,
      shape: t.shape,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      seats: t.seats,
      active: t.active === 1
    }))
  }
}

export function listPaymentMethods(db: Database): PaymentMethodDto[] {
  const rows = db.prepare('SELECT * FROM payment_methods ORDER BY sort, id').all() as {
    id: string
    code: string
    name_json: string
    opens_drawer: number
    active: number
    sort: number
  }[]
  return rows.map((m) => ({ id: m.id, code: m.code, name: nameOf(m.name_json, m.code), opensDrawer: m.opens_drawer === 1, active: m.active === 1, sort: m.sort }))
}

export function listRouting(db: Database): CategoryRouteDto[] {
  const categories = db.prepare('SELECT id, name_json FROM categories ORDER BY sort, id').all() as { id: string; name_json: string }[]
  const routes = db.prepare('SELECT category_id, printer_id FROM category_printers ORDER BY printer_id').all() as { category_id: string; printer_id: string }[]
  const byCategory = new Map<string, string[]>()
  for (const r of routes) byCategory.set(r.category_id, [...(byCategory.get(r.category_id) ?? []), r.printer_id])
  return categories.map((c) => ({ categoryId: c.id, categoryName: nameOf(c.name_json, c.id), printerIds: byCategory.get(c.id) ?? [] }))
}

/** Users and profiles, without any hash. */
export function listStaff(db: Database): StaffDto {
  const repo = createUsersRepo(db)
  const profiles = (db.prepare('SELECT id FROM profiles ORDER BY id').pluck().all() as string[])
    .map((id) => repo.getProfile(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
  return {
    users: repo.listUsers().map((u) => ({
      id: u.id,
      displayName: u.displayName,
      username: u.username,
      profileId: u.profileId,
      lang: u.lang,
      active: u.active,
      createdAt: u.createdAt
    })),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, permissions: p.permissions, maxDiscountBp: p.maxDiscountBp }))
  }
}
