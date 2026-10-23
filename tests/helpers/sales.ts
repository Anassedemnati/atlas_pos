import { newId } from '../../src/shared/ids'
import { PERMISSIONS, type Permission } from '../../src/shared/permissions'
import type { Result } from '../../src/shared/result'
import { createEventBus, type DomainEvent } from '../../src/main/application/events'
import type { PrintJob, PrintSpooler } from '../../src/main/application/ports'
import { createCustomersService, type CustomersService } from '../../src/main/application/usecases/customers'
import { createDaysService, type DaysService } from '../../src/main/application/usecases/days'
import { createOrdersService, type OrdersService } from '../../src/main/application/usecases/orders'
import { createTicketsService, type TicketsService } from '../../src/main/application/usecases/tickets'
import { createUsersService, type UsersService } from '../../src/main/application/usecases/users'
import type { Session } from '../../src/main/domain/users/session'
import { createSettingsRepo, type SettingsRepo } from '../../src/main/infrastructure/db/repos/settings-repo'
import { createUnitOfWork, type UnitOfWork } from '../../src/main/infrastructure/db/uow'
import { mutableClock, type MutableClock } from './clock'
import { tempDb, type TempDb } from './db'
import { CASHIER_PERMISSIONS, seedUsers, type Seeded } from './users'

/** The value of a successful result; fails the test with the error otherwise. */
export function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

/** The error code of a refused result (undefined when it succeeded). */
export const code = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.code)

/** A local wall-clock instant as ISO: the cut-over hour is local time, so tests build their instants in it. */
export const local = (month: number, day: number, hour: number, minute = 0): string =>
  new Date(2026, month - 1, day, hour, minute).toISOString()

export const LEGAL = {
  raisonSociale: 'Dar Atlas SARL',
  nomCommercial: 'Restaurant Dar Atlas',
  adresse: '12 rue Tarik',
  ville: 'Marrakech',
  telephone: '0524000000',
  ice: '001234567000089',
  if: '12345678',
  rc: '98765',
  patente: '45678901'
}

export interface Fixtures {
  categories: { plats: string; boissons: string }
  products: {
    tajine: string
    couscous: string
    the: string
    /** Stock tracked, 10 in stock. */
    eau: string
    /** Sold by weight, 60,00 DH / kg. */
    pain: string
    /** Course 1, 2 and 3 for the kitchen tests. */
    salade: string
    brochettes: string
    cornes: string
    /** A set menu (course 0) with a course "Plat" offering tajine or couscous (+5,00 DH). */
    menu: string
  }
  menu: { courseId: string }
  modifiers: { groupId: string; saignant: string; bienCuit: string }
  tables: { t4: string; t5: string; t6: string }
}

/** Two categories, a few products, cash and card, three tables, the business legal block. */
function seedSales(h: { t: TempDb }): Fixtures {
  const db = h.t.db
  const json = JSON.stringify
  const cat = (fr: string): string => {
    const id = newId()
    db.prepare('INSERT INTO categories (id, name_json, color) VALUES (?, ?, ?)').run(id, json({ fr }), '#0FA3A3')
    return id
  }
  const categories = { plats: cat('Plats'), boissons: cat('Boissons') }
  const product = (
    categoryId: string,
    name: { fr: string; ar?: string; en?: string },
    priceCents: number,
    vatBp: number,
    over: { soldByWeight?: boolean; stockMilli?: number; course?: number } = {}
  ): string => {
    const id = newId()
    db.prepare(
      `INSERT INTO products (id, category_id, name_json, price_cents, vat_bp, sold_by_weight, stock_tracked, stock_milli, course)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      categoryId,
      json(name),
      priceCents,
      vatBp,
      over.soldByWeight ? 1 : 0,
      over.stockMilli === undefined ? 0 : 1,
      over.stockMilli ?? 0,
      over.course ?? 0
    )
    return id
  }
  const products = {
    tajine: product(categories.plats, { fr: 'Tajine', ar: 'طاجين', en: 'Tagine' }, 7000, 1000),
    couscous: product(categories.plats, { fr: 'Couscous' }, 9500, 1000),
    the: product(categories.boissons, { fr: 'Thé à la menthe' }, 1200, 2000),
    eau: product(categories.boissons, { fr: 'Eau' }, 750, 2000, { stockMilli: 10000 }),
    pain: product(categories.plats, { fr: 'Pain' }, 6000, 0, { soldByWeight: true }),
    salade: product(categories.plats, { fr: 'Salade' }, 3000, 1000, { course: 1 }),
    brochettes: product(categories.plats, { fr: 'Brochettes' }, 8000, 1000, { course: 2 }),
    cornes: product(categories.plats, { fr: 'Cornes de gazelle' }, 2500, 1000, { course: 3 }),
    menu: product(categories.plats, { fr: 'Menu du jour' }, 12000, 1000)
  }
  const menuId = newId()
  const courseId = newId()
  db.prepare('INSERT INTO menus (id, product_id) VALUES (?, ?)').run(menuId, products.menu)
  db.prepare('INSERT INTO menu_courses (id, menu_id, name_json, choose_count) VALUES (?, ?, ?, 1)').run(
    courseId,
    menuId,
    json({ fr: 'Plat' })
  )
  db.prepare('INSERT INTO menu_course_items (course_id, product_id, supplement_cents) VALUES (?, ?, 0), (?, ?, 500)').run(
    courseId,
    products.tajine,
    courseId,
    products.couscous
  )

  const groupId = newId()
  const saignant = newId()
  const bienCuit = newId()
  db.prepare('INSERT INTO modifier_groups (id, name_json, min_select, max_select) VALUES (?, ?, 1, 1)').run(
    groupId,
    json({ fr: 'Cuisson' })
  )
  db.prepare('INSERT INTO modifiers (id, group_id, name_json, price_delta_cents) VALUES (?, ?, ?, 0), (?, ?, ?, 200)').run(
    saignant,
    groupId,
    json({ fr: 'Saignant' }),
    bienCuit,
    groupId,
    json({ fr: 'Bien cuit' })
  )
  db.prepare('INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?, ?)').run(products.brochettes, groupId)

  for (const [code, fr, drawer] of [
    ['cash', 'Espèces', 1],
    ['card', 'Carte bancaire', 0]
  ] as const) {
    db.prepare('INSERT INTO payment_methods (id, code, name_json, opens_drawer) VALUES (?, ?, ?, ?)').run(
      newId(),
      code,
      json({ fr }),
      drawer
    )
  }
  const roomId = newId()
  db.prepare('INSERT INTO rooms (id, name_json) VALUES (?, ?)').run(roomId, json({ fr: 'Salle' }))
  const table = (label: string): string => {
    const id = newId()
    db.prepare('INSERT INTO tables (id, room_id, label) VALUES (?, ?, ?)').run(id, roomId, label)
    return id
  }
  const tables = { t4: table('T4'), t5: table('T5'), t6: table('T6') }
  return { categories, products, menu: { courseId }, modifiers: { groupId, saignant, bienCuit }, tables }
}

/**
 * A spooler that writes each job as a `print_jobs` row in the caller's transaction, so a job is there
 * if and only if the change it prints was committed. `jobs()` reads them back in order.
 */
export interface RecordingSpooler extends PrintSpooler {
  jobs(): PrintJob[]
}

function recordingSpooler(db: TempDb['db']): RecordingSpooler {
  return {
    enqueue(tx, job) {
      const at = tx.clock.now().toISOString()
      tx.db
        .prepare('INSERT INTO print_jobs (id, printer_id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId(), JSON.stringify(job.target), job.kind, JSON.stringify(job.payload), at, at)
    },
    jobs: () =>
      (
        db.prepare('SELECT printer_id, kind, payload_json FROM print_jobs ORDER BY rowid').all() as {
          printer_id: string
          kind: PrintJob['kind']
          payload_json: string
        }[]
      ).map((row) => ({ target: JSON.parse(row.printer_id), kind: row.kind, payload: JSON.parse(row.payload_json) }))
  }
}

export interface SalesHarness {
  t: TempDb
  clock: MutableClock
  uow: UnitOfWork
  settings: SettingsRepo
  users: UsersService
  seeded: Seeded
  fx: Fixtures
  orders: OrdersService
  tickets: TicketsService
  days: DaysService
  customers: CustomersService
  spooler: RecordingSpooler
  /** Labels passed to the full backup trigger. */
  backups: string[]
  published: DomainEvent[]
  manager: Session
  cashier: Session
  /** Serveur: order.discount up to 0 %, nothing else. */
  waiter: Session
  eventRows(type?: string): { type: string; entity: string; entity_id: string | null; user_id: string | null; data: unknown }[]
  count(table: string, where?: string): number
  stockOf(productId: string): number
  cleanup(): void
}

export function salesHarness(startIso = local(10, 22, 11)): SalesHarness {
  const t = tempDb()
  const clock = mutableClock(startIso)
  const bus = createEventBus()
  const published: DomainEvent[] = []
  for (const type of ['order.changed', 'order.sent', 'ticket.closed', 'day.closed'] as const) {
    bus.subscribe(type, (e) => published.push(e))
  }
  const uow = createUnitOfWork(t.db, clock, bus)
  const settings = createSettingsRepo(t.db)
  const seeded = seedUsers(t.db)
  const users = createUsersService({ db: t.db, uow, clock, settings })
  uow.run((tx) => settings.set(tx, 'business.legal', LEGAL))
  const fx = seedSales({ t })
  const spooler = recordingSpooler(t.db)
  const backups: string[] = []
  const backup = {
    runFull: async (_kind: 'full', label?: string) => {
      backups.push(label ?? '')
      return {}
    }
  }
  const deps = { db: t.db, uow, clock, settings, spooler, overrides: users, backup }
  const session = (userId: string, displayName: string, permissions: readonly Permission[], maxDiscountBp: number): Session => ({
    userId,
    displayName,
    lang: 'fr',
    permissions: new Set(permissions),
    maxDiscountBp,
    isTechnician: false
  })
  return {
    t,
    clock,
    uow,
    settings,
    users,
    seeded,
    fx,
    orders: createOrdersService(deps),
    tickets: createTicketsService(deps),
    days: createDaysService(deps),
    customers: createCustomersService(deps),
    spooler,
    backups,
    published,
    manager: session(seeded.users.amine, 'Amine Benali', PERMISSIONS, 10000),
    cashier: session(seeded.users.sara, 'Sara El Idrissi', CASHIER_PERMISSIONS, 1000),
    waiter: session(seeded.users.youssef, 'Youssef', ['order.discount'], 0),
    eventRows: (type) =>
      (
        t.db
          .prepare(
            `SELECT type, entity, entity_id, user_id, data_json FROM event_log ${type ? 'WHERE type = ?' : ''} ORDER BY id`
          )
          .all(...(type ? [type] : [])) as {
          type: string
          entity: string
          entity_id: string | null
          user_id: string | null
          data_json: string | null
        }[]
      ).map(({ data_json, ...row }) => ({ ...row, data: data_json === null ? null : JSON.parse(data_json) })),
    count: (table, where) =>
      (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get() as { n: number }).n,
    stockOf: (productId) =>
      (t.db.prepare('SELECT stock_milli AS n FROM products WHERE id = ?').get(productId) as { n: number }).n,
    cleanup: () => t.cleanup()
  }
}
