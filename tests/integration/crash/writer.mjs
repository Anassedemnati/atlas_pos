// Crash-harness writer: the child process that gets SIGKILLed (see crash.test.ts).
//
// Usage: node --experimental-strip-types writer.mjs <db file>
//
// It plays a till that never stops selling, with the real database layer (openDatabase, migrate,
// nextSequence) and SQL that mirrors the order use cases of Task 12 (addLine, closeOrder):
//   - every line is added in its own transaction (the first line of an order creates the order);
//   - once an order has 5 lines it is closed: ticket number from the `ticket` sequence, ticket row
//     and `orders.status = 'closed'` in ONE transaction.
// It prints one line per COMMITTED write, strictly after the commit returned:
//   READY                  setup is done; the parent starts its kill timer here
//   ACK line <line id>
//   ACK ticket <number>
// The output goes through fs.writeSync on fd 1, so an ACK has left the process (the harness points
// stdout at a file) before the next statement runs and cannot be lost in a stdout buffer when the
// process is killed.
//
// A restarted writer carries on with the order a previous run left open, like a till after a power
// cut. An order that already has 5 lines (killed between its last line and the close) is closed
// first.
import { writeSync } from 'node:fs'
import { register } from 'node:module'

// The app code is TypeScript: node strips the types, ts-hooks.mjs resolves what Vite would.
register('./ts-hooks.mjs', import.meta.url)
const src = '../../../src/'
const { openDatabase } = await import(`${src}main/infrastructure/db/connection.ts`)
const { migrate } = await import(`${src}main/infrastructure/db/migrate.ts`)
const { nextSequence } = await import(`${src}main/infrastructure/db/sequences.ts`)
const { newId } = await import(`${src}shared/ids.ts`)

const LINES_PER_TICKET = 5
const USER_ID = 'crash-writer'
// Safety net: a writer that is never killed (the test runner died) stops by itself.
const GIVE_UP_AT = Date.now() + 30_000

/** Writes the whole text to stdout synchronously, retrying partial writes (and EAGAIN if stdout is a full pipe). */
function emit(text) {
  const bytes = Buffer.from(text)
  let written = 0
  while (written < bytes.length) {
    try {
      written += writeSync(1, bytes, written)
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error
    }
  }
}

const db = openDatabase(process.argv[2])
migrate(db)

/** The business day (one, opened on the first run) all tickets belong to. */
const dayId = db
  .transaction(() => {
    const open = db.prepare('SELECT id FROM business_days WHERE closed_at IS NULL ORDER BY number LIMIT 1').get()
    if (open) return open.id
    const id = newId()
    db.prepare(
      `INSERT INTO business_days (id, number, opened_at)
       VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM business_days), ?)`
    ).run(id, new Date().toISOString())
    return id
  })
  .immediate()

const insertOrder = db.prepare(
  `INSERT INTO orders (id, day_id, type, status, user_id, opened_at, updated_at)
   VALUES (?, ?, 'counter', 'open', ?, ?, ?)`
)
const insertLine = db.prepare(
  `INSERT INTO order_lines (id, order_id, seq, product_id, name_json, qty_milli, unit_price_cents, vat_bp, user_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
const touchOrder = db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?')
const countLines = db.prepare('SELECT count(*) AS n FROM order_lines WHERE order_id = ?')
const selectLines = db.prepare(
  'SELECT id, seq, product_id, qty_milli, unit_price_cents, vat_bp FROM order_lines WHERE order_id = ? ORDER BY seq'
)
const closeOrderRow = db.prepare(
  "UPDATE orders SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open'"
)
const insertTicket = db.prepare(
  `INSERT INTO tickets (id, kind, number, label, order_id, day_id, closed_at, user_id, total_cents, snapshot_json)
   VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)`
)

/** Mirrors the `addLine` use case. `orderId` is null when no order is open: the line opens one. */
const addLine = db.transaction((orderId) => {
  const now = new Date().toISOString()
  const id = orderId ?? newId()
  if (orderId === null) insertOrder.run(id, dayId, USER_ID, now, now)
  const seq = countLines.get(id).n + 1
  const lineId = newId()
  insertLine.run(lineId, id, seq, `product-${seq}`, '{"fr":"Article"}', 1000, 100 * seq, 2000, USER_ID, now)
  touchOrder.run(now, id)
  return { orderId: id, lineId, lines: seq }
})

/** Mirrors the `closeOrder` use case: the ticket and the closed status commit together. */
const closeOrder = db.transaction((orderId) => {
  const now = new Date().toISOString()
  const lines = selectLines.all(orderId)
  const total = lines.reduce((sum, l) => sum + Math.round((l.qty_milli * l.unit_price_cents) / 1000), 0)
  if (closeOrderRow.run(now, orderId).changes !== 1) throw new Error(`order ${orderId} is not open`)
  const number = nextSequence(db, 'ticket')
  const snapshot = JSON.stringify({ orderId, lines, totalCents: total })
  insertTicket.run(newId(), number, String(number).padStart(6, '0'), orderId, dayId, now, USER_ID, total, snapshot)
  return number
})

// Where the previous run stopped.
let order = null
const open = db.prepare("SELECT id FROM orders WHERE status = 'open' ORDER BY opened_at, id LIMIT 1").get()
if (open) order = { id: open.id, lines: countLines.get(open.id).n }

emit('READY\n')

while (Date.now() < GIVE_UP_AT) {
  if (order !== null && order.lines >= LINES_PER_TICKET) {
    const number = closeOrder.immediate(order.id)
    emit(`ACK ticket ${number}\n`)
    order = null
  } else {
    const added = addLine.immediate(order?.id ?? null)
    emit(`ACK line ${added.lineId}\n`)
    order = { id: added.orderId, lines: added.lines }
  }
}
// Reached only if nobody killed us: exit non-zero so the test notices.
process.stderr.write('writer was not killed within 30 s\n')
process.exit(2)
