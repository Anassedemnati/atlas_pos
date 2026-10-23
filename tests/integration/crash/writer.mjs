// Crash-harness writer: the child process that gets SIGKILLed (see crash.test.ts).
//
// Usage: node --experimental-strip-types writer.mjs <db file>
//
// It plays a till that never stops selling, through the real order use cases of the app (openOrder,
// addLine, addPayment, closeOrder) on the real database layer, each call being one transaction:
//   - a counter order is opened, then 5 lines are added one by one;
//   - the order is paid in cash (one payment, the amount due, a round banknote handed over);
//   - it is closed: ticket number, ticket row with its snapshot, receipt job, order closed, in ONE transaction.
// It prints one line per COMMITTED write, strictly after the use case returned:
//   READY                  setup is done; the parent starts its kill timer here
//   ACK line <line id>
//   ACK payment <payment id>
//   ACK ticket <number>
// The output goes through fs.writeSync on fd 1, so an ACK has left the process (the harness points
// stdout at a file) before the next statement runs and cannot be lost in a stdout buffer when the
// process is killed.
//
// A restarted writer carries on with the order a previous run left open, like a till after a power
// cut: an empty order gets its lines, a full one is paid, a paid one is closed.
import { writeSync } from 'node:fs'
import { register } from 'node:module'

// The app code is TypeScript: node strips the types, ts-hooks.mjs resolves what Vite would.
register('./ts-hooks.mjs', import.meta.url)
const src = '../../../src/'
const { openDatabase } = await import(`${src}main/infrastructure/db/connection.ts`)
const { migrate } = await import(`${src}main/infrastructure/db/migrate.ts`)
const { createUnitOfWork } = await import(`${src}main/infrastructure/db/uow.ts`)
const { createSettingsRepo } = await import(`${src}main/infrastructure/db/repos/settings-repo.ts`)
const { createEventBus } = await import(`${src}main/application/events.ts`)
const { createOrdersService } = await import(`${src}main/application/usecases/orders/index.ts`)
const { createTicketsService } = await import(`${src}main/application/usecases/tickets/index.ts`)
const { createDaysService } = await import(`${src}main/application/usecases/days/index.ts`)
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

/** The value of a use case result; a refusal is a bug of the writer, so it crashes (the test sees it). */
function ok(result) {
  if (!result.ok) throw new Error(`use case refused: ${result.error.code} ${JSON.stringify(result.error.params ?? {})}`)
  return result.value
}

const db = openDatabase(process.argv[2])
migrate(db)

// What a setup would have created: a category, 5 products, cash. Fixed ids, never replaced, so every
// restart finds the same rows.
db.transaction(() => {
  db.prepare("INSERT OR IGNORE INTO categories (id, name_json, color) VALUES ('crash-cat', '{\"fr\":\"Articles\"}', '#0FA3A3')").run()
  for (let i = 1; i <= LINES_PER_TICKET; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO products (id, category_id, name_json, price_cents, vat_bp)
       VALUES (?, 'crash-cat', ?, ?, 2000)`
    ).run(`crash-product-${i}`, JSON.stringify({ fr: `Article ${i}` }), 100 * i)
  }
  db.prepare(
    "INSERT OR IGNORE INTO payment_methods (id, code, name_json, opens_drawer) VALUES ('crash-cash', 'cash', '{\"fr\":\"Espèces\"}', 1)"
  ).run()
}).immediate()

const clock = { now: () => new Date() }
const uow = createUnitOfWork(db, clock, createEventBus())
// A stand-in for the print queue of Task 13: the job is a row written in the use case's transaction.
const spooler = {
  enqueue(tx, job) {
    const at = tx.clock.now().toISOString()
    tx.db
      .prepare('INSERT INTO print_jobs (id, printer_id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), job.target.printerId ?? job.target.role ?? '', job.kind, JSON.stringify(job.payload), at, at)
  }
}
const refuse = () => ({ ok: false, error: { code: 'forbidden', messageKey: 'errors.forbidden' } })
const deps = {
  db,
  uow,
  clock,
  settings: createSettingsRepo(db),
  spooler,
  overrides: { checkDiscount: refuse, consumeOverride: refuse }
}
const orders = createOrdersService(deps)
const tickets = createTicketsService(deps)
const days = createDaysService(deps)
// `day.close` only for a run that crosses the cut-over hour (05:00): the till would ask for the Z.
const session = {
  userId: USER_ID,
  displayName: 'Crash writer',
  lang: 'fr',
  permissions: new Set(['day.close']),
  maxDiscountBp: 0,
  isTechnician: false
}

function openOrder() {
  const opened = orders.openOrder(session, { type: 'counter' })
  if (!opened.ok && opened.error.code === 'day_must_close') {
    ok(days.closeDay(session))
    return ok(orders.openOrder(session, { type: 'counter' }))
  }
  return ok(opened)
}

// Where the previous run stopped.
const left = db.prepare("SELECT id FROM orders WHERE status = 'open' ORDER BY opened_at, id LIMIT 1").get()
let order = left ? ok(orders.getOrder(session, left.id)) : null

emit('READY\n')

while (Date.now() < GIVE_UP_AT) {
  if (order === null) {
    order = openOrder()
  } else if (order.lines.length < LINES_PER_TICKET) {
    const productId = `crash-product-${order.lines.length + 1}`
    order = ok(orders.addLine(session, order.id, { productId, qtyMilli: 1000, modifierIds: [], note: '' }))
    emit(`ACK line ${order.lines.at(-1).id}\n`)
  } else if (order.dueCents > 0) {
    // The customer hands over the next 20,00 DH banknote above what is due.
    const handed = Math.ceil((order.dueCents + 1) / 2000) * 2000
    order = ok(orders.addPayment(session, order.id, { methodCode: 'cash', amountCents: handed }))
    emit(`ACK payment ${order.payments.at(-1).id}\n`)
  } else {
    const ticket = ok(tickets.closeOrder(session, order.id))
    emit(`ACK ticket ${ticket.number}\n`)
    order = null
  }
}
// Reached only if nobody killed us: exit non-zero so the test notices.
process.stderr.write('writer was not killed within 30 s\n')
process.exit(2)
