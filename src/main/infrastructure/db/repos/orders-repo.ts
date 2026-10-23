import type { PaymentDto } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import type { OrderLine } from '../../../domain/order/line'
import type { Order } from '../../../domain/order/order'
import type { Database } from '../connection'
import type { Tx } from '../uow'
import { discountColumns, toDiscount, toLine, toPayment, type LineRow, type OrderRow, type PaymentRow } from './order-rows'

/** A line as stored: the priced line plus who rang it, when, and why it was voided or offered. */
export interface StoredLine extends OrderLine {
  voidReason: string
  freeReason: string
  userId: string
  createdAt: string
}

/** An order with its lines (by `seq`, void ones included) and payments (in the order they were taken). */
export interface StoredOrder extends Order {
  lines: StoredLine[]
  payments: PaymentDto[]
  tableLabel: string | null
}

export interface TableRef {
  id: string
  label: string
  active: boolean
}

export interface PaymentMethodRef {
  code: string
  name: LocalizedName
  opensDrawer: boolean
  active: boolean
}

export interface MenuCourseRef {
  id: string
  chooseCount: number
  items: { productId: string; supplementCents: number }[]
}

const ORDER_SELECT = `SELECT o.*, t.label AS table_label FROM orders o LEFT JOIN tables t ON t.id = o.table_id`

export interface OrdersRepo {
  get(id: string): StoredOrder | undefined
  /** The open or parked order on a table. */
  findOnTable(tableId: string): string | undefined
  /** Every order still open or parked, oldest first. */
  listUnfinished(): StoredOrder[]
  /** The void lines of the orders of a business day. */
  voidLinesOfDay(dayId: string): StoredLine[]
  /** The `seq` the next line of the order gets. */
  nextSeq(orderId: string): number
  table(id: string): TableRef | undefined
  paymentMethod(code: string): PaymentMethodRef | undefined
  /** The courses of the set menu sold as this product, in order. */
  menuCourses(productId: string): MenuCourseRef[] | undefined

  insert(tx: Tx, order: Omit<StoredOrder, 'lines' | 'payments' | 'tableLabel'>): void
  /** Writes the header: table, covers, status, customer, note, ticket discount, `updated_at`. */
  updateHeader(tx: Tx, order: Omit<StoredOrder, 'lines' | 'payments' | 'tableLabel'>): void
  insertLine(tx: Tx, orderId: string, line: StoredLine): void
  /** Writes every mutable field of the line (quantity, status, kitchen, discount, free, note). */
  updateLine(tx: Tx, line: StoredLine): void
  moveLine(tx: Tx, lineId: string, toOrderId: string, seq: number): void
  insertPayment(tx: Tx, orderId: string, payment: PaymentDto): void
  deletePayment(tx: Tx, paymentId: string): void
  movePayments(tx: Tx, fromOrderId: string, toOrderId: string): void
}

export function createOrdersRepo(db: Database): OrdersRepo {
  const linesOf = (orderId: string): StoredLine[] =>
    (db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY seq, id').all(orderId) as LineRow[]).map(toLine)
  const paymentsOf = (orderId: string): PaymentDto[] =>
    (db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, rowid').all(orderId) as PaymentRow[]).map(
      toPayment
    )
  const toOrder = (row: OrderRow): StoredOrder => ({
    id: row.id,
    dayId: row.day_id,
    type: row.type,
    tableId: row.table_id,
    tableLabel: row.table_label,
    covers: row.covers,
    orderNumber: row.order_number,
    status: row.status,
    userId: row.user_id,
    customerId: row.customer_id,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    note: row.note,
    discount: toDiscount(row.discount_kind, row.discount_value, row.discount_reason),
    lines: linesOf(row.id),
    payments: paymentsOf(row.id)
  })

  return {
    get(id) {
      const row = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as OrderRow | undefined
      return row ? toOrder(row) : undefined
    },

    findOnTable: (tableId) =>
      (
        db
          .prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open', 'parked') ORDER BY opened_at, id LIMIT 1")
          .get(tableId) as { id: string } | undefined
      )?.id,

    listUnfinished: () =>
      (db.prepare(`${ORDER_SELECT} WHERE o.status IN ('open', 'parked') ORDER BY o.opened_at, o.id`).all() as OrderRow[]).map(
        toOrder
      ),

    voidLinesOfDay: (dayId) =>
      (
        db
          .prepare(
            `SELECT l.* FROM order_lines l JOIN orders o ON o.id = l.order_id
             WHERE o.day_id = ? AND l.status = 'void' ORDER BY l.created_at, l.id`
          )
          .all(dayId) as LineRow[]
      ).map(toLine),

    nextSeq: (orderId) =>
      (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM order_lines WHERE order_id = ?').get(orderId) as { n: number }).n,

    table(id) {
      const row = db.prepare('SELECT id, label, active FROM tables WHERE id = ?').get(id) as
        | { id: string; label: string; active: number }
        | undefined
      return row ? { id: row.id, label: row.label, active: row.active === 1 } : undefined
    },

    paymentMethod(code) {
      const row = db.prepare('SELECT code, name_json, opens_drawer, active FROM payment_methods WHERE code = ?').get(code) as
        | { code: string; name_json: string; opens_drawer: number; active: number }
        | undefined
      return row
        ? {
            code: row.code,
            name: JSON.parse(row.name_json) as LocalizedName,
            opensDrawer: row.opens_drawer === 1,
            active: row.active === 1
          }
        : undefined
    },

    menuCourses(productId) {
      const menu = db.prepare('SELECT id FROM menus WHERE product_id = ?').get(productId) as { id: string } | undefined
      if (!menu) return undefined
      const courses = db
        .prepare('SELECT id, choose_count FROM menu_courses WHERE menu_id = ? ORDER BY sort, id')
        .all(menu.id) as { id: string; choose_count: number }[]
      return courses.map((course) => ({
        id: course.id,
        chooseCount: course.choose_count,
        items: (
          db
            .prepare('SELECT product_id, supplement_cents FROM menu_course_items WHERE course_id = ?')
            .all(course.id) as { product_id: string; supplement_cents: number }[]
        ).map((item) => ({ productId: item.product_id, supplementCents: item.supplement_cents }))
      }))
    },

    insert(tx, o) {
      tx.db
        .prepare(
          `INSERT INTO orders (id, day_id, type, table_id, covers, order_number, status, user_id, customer_id,
                               opened_at, updated_at, note, discount_kind, discount_value, discount_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          o.id,
          o.dayId,
          o.type,
          o.tableId,
          o.covers,
          o.orderNumber,
          o.status,
          o.userId,
          o.customerId,
          o.openedAt,
          o.updatedAt,
          o.note,
          ...discountColumns(o.discount)
        )
    },

    updateHeader(tx, o) {
      tx.db
        .prepare(
          `UPDATE orders SET table_id = ?, covers = ?, status = ?, customer_id = ?, note = ?, updated_at = ?,
                  discount_kind = ?, discount_value = ?, discount_reason = ? WHERE id = ?`
        )
        .run(o.tableId, o.covers, o.status, o.customerId, o.note, o.updatedAt, ...discountColumns(o.discount), o.id)
    },

    insertLine(tx, orderId, l) {
      tx.db
        .prepare(
          `INSERT INTO order_lines (id, order_id, seq, product_id, name_json, qty_milli, unit_price_cents, vat_bp,
                                    modifiers_json, note, course, status, void_reason, sent_at, discount_kind,
                                    discount_value, discount_reason, free, free_reason, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          l.id,
          orderId,
          l.seq,
          l.productId,
          JSON.stringify(l.name),
          l.qtyMilli,
          l.unitPriceCents,
          l.vatBp,
          JSON.stringify(l.modifiers),
          l.note,
          l.course,
          l.status,
          l.voidReason,
          l.sentAt,
          ...discountColumns(l.discount),
          l.free ? 1 : 0,
          l.freeReason,
          l.userId,
          l.createdAt
        )
    },

    updateLine(tx, l) {
      tx.db
        .prepare(
          `UPDATE order_lines SET qty_milli = ?, note = ?, status = ?, void_reason = ?, sent_at = ?, discount_kind = ?,
                  discount_value = ?, discount_reason = ?, free = ?, free_reason = ? WHERE id = ?`
        )
        .run(
          l.qtyMilli,
          l.note,
          l.status,
          l.voidReason,
          l.sentAt,
          ...discountColumns(l.discount),
          l.free ? 1 : 0,
          l.freeReason,
          l.id
        )
    },

    moveLine(tx, lineId, toOrderId, seq) {
      tx.db.prepare('UPDATE order_lines SET order_id = ?, seq = ? WHERE id = ?').run(toOrderId, seq, lineId)
    },

    insertPayment(tx, orderId, p) {
      tx.db
        .prepare(
          `INSERT INTO payments (id, order_id, method_code, amount_cents, tendered_cents, created_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(p.id, orderId, p.methodCode, p.amountCents, p.tenderedCents, p.createdAt, p.userId)
    },

    deletePayment(tx, paymentId) {
      tx.db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId)
    },

    movePayments(tx, fromOrderId, toOrderId) {
      tx.db.prepare('UPDATE payments SET order_id = ? WHERE order_id = ?').run(toOrderId, fromOrderId)
    }
  }
}
