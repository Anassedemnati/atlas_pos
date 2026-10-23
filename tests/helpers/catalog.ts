import { newId } from '../../src/shared/ids'
import { PERMISSIONS } from '../../src/shared/permissions'
import { createEventBus, type DomainEvent } from '../../src/main/application/events'
import { createCatalogService, type CatalogService } from '../../src/main/application/usecases/catalog'
import type { Session } from '../../src/main/domain/users/session'
import type { Database } from '../../src/main/infrastructure/db/connection'
import { createUnitOfWork, type UnitOfWork } from '../../src/main/infrastructure/db/uow'
import { mutableClock, type MutableClock } from './clock'
import { tempDb, type TempDb } from './db'
import { sessionOf } from './users'

export interface CatalogHarness {
  t: TempDb
  clock: MutableClock
  uow: UnitOfWork
  service: CatalogService
  manager: Session
  cashier: Session
  /** Every event published on the bus, in order. */
  published: DomainEvent[]
  eventRows(): { type: string; entity: string; entity_id: string | null; user_id: string | null; data_json: string | null }[]
  count(table: string): number
  cleanup(): void
}

export function catalogHarness(): CatalogHarness {
  const t = tempDb()
  const clock = mutableClock()
  const bus = createEventBus()
  const published: DomainEvent[] = []
  bus.subscribe('catalog.changed', (e) => published.push(e))
  const uow = createUnitOfWork(t.db, clock, bus)
  return {
    t,
    clock,
    uow,
    service: createCatalogService({ db: t.db, uow }),
    published,
    manager: sessionOf('u-manager', PERMISSIONS, 10000),
    cashier: sessionOf('u-cashier', ['order.discount', 'report.x'], 1000),
    eventRows: () =>
      t.db.prepare('SELECT type, entity, entity_id, user_id, data_json FROM event_log ORDER BY id').all() as ReturnType<
        CatalogHarness['eventRows']
      >,
    count: (table) => (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    cleanup: () => t.cleanup()
  }
}

/** Puts one sold line of `productId` in the database (a day, an order, a line), as the till will. */
export function insertOrderLine(db: Database, productId: string): void {
  const dayId = newId()
  const orderId = newId()
  db.prepare('INSERT INTO business_days (id, number, opened_at) VALUES (?, 1, ?)').run(dayId, '2026-10-22T08:00:00.000Z')
  db.prepare(
    `INSERT INTO orders (id, day_id, type, user_id, opened_at, updated_at)
     VALUES (?, ?, 'counter', 'u-manager', ?, ?)`
  ).run(orderId, dayId, '2026-10-22T09:00:00.000Z', '2026-10-22T09:00:00.000Z')
  db.prepare(
    `INSERT INTO order_lines (id, order_id, seq, product_id, name_json, qty_milli, unit_price_cents, vat_bp, user_id, created_at)
     VALUES (?, ?, 1, ?, '{"fr":"x"}', 1000, 500, 2000, 'u-manager', ?)`
  ).run(newId(), orderId, productId, '2026-10-22T09:00:00.000Z')
}
