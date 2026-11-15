import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FloorDto } from '../../src/shared/dto'
import type { FloorInput } from '../../src/main/application/usecases/config/floor'
import { listFloor } from '../../src/main/application/usecases/config/lists'
import { code, ok, salesHarness, type SalesHarness } from '../helpers/sales'

describe('floor.save', () => {
  let h: SalesHarness
  beforeEach(() => {
    h = salesHarness()
  })
  afterEach(() => h.cleanup())

  /** The saved plan as the editor would send it back unchanged. */
  const current = (): FloorInput => {
    const floor = listFloor(h.t.db)
    return {
      rooms: floor.rooms.map((r) => ({ id: r.id, name: r.name })),
      tables: floor.tables.filter((t) => t.active).map(({ active: _active, ...t }) => t)
    }
  }
  const save = (input: FloorInput, session = h.manager) => h.floor.saveFloor(session, input)
  const withTable = (input: FloorInput, over: Partial<FloorInput['tables'][number]> = {}): FloorInput => ({
    ...input,
    tables: [...input.tables, { id: 'new-table', roomId: input.rooms[0]!.id, label: 'T9', shape: 'round', x: 40, y: 50, w: 120, h: 120, seats: 4, ...over }]
  })
  const labels = (floor: FloorDto) => floor.tables.filter((t) => t.active).map((t) => t.label).sort()

  it('moves and resizes a table, adds a room with a table in it, and orders the rooms as listed', () => {
    const before = current()
    const t4 = before.tables.find((t) => t.label === 'T4')!
    const terrace = { id: 'room-terrace', name: { fr: 'Terrasse' } }
    const saved = ok(
      save({
        rooms: [terrace, ...before.rooms],
        tables: [
          ...before.tables.map((t) => (t.id === t4.id ? { ...t, x: 300, y: 200, w: 140, h: 90 } : t)),
          { id: 'table-t1', roomId: terrace.id, label: 'T1', shape: 'square', x: 0, y: 0, w: 100, h: 100, seats: 2 }
        ]
      })
    )
    expect(saved.rooms.map((r) => r.name.fr)).toEqual(['Terrasse', 'Salle'])
    expect(saved.tables.find((t) => t.id === t4.id)).toMatchObject({ x: 300, y: 200, w: 140, h: 90, active: true })
    expect(saved.tables.find((t) => t.id === 'table-t1')).toMatchObject({ roomId: 'room-terrace', seats: 2, active: true })
    expect(listFloor(h.t.db)).toEqual(saved)
    expect(h.eventRows('floor.saved')).toHaveLength(1)
  })

  it('validates what is typed: a label, a size and the seats, the room and the label unique in the room', () => {
    const input = current()
    const refusal = (over: Partial<FloorInput['tables'][number]>) => {
      const result = save(withTable(input, over))
      return result.ok ? 'ok' : `${result.error.code}:${String(result.error.params?.['field'])}`
    }
    expect(refusal({ label: '   ' })).toBe('invalid_input:tables.3.label')
    expect(refusal({ w: 0 })).toBe('invalid_input:tables.3.w')
    expect(refusal({ h: 0 })).toBe('invalid_input:tables.3.h')
    expect(refusal({ seats: 0 })).toBe('invalid_input:tables.3.seats')
    expect(refusal({ x: -1 })).toBe('invalid_input:tables.3.x')
    expect(refusal({ roomId: 'nowhere' })).toBe('invalid_input:tables.3.roomId')
    expect(refusal({ label: 't4' })).toBe('invalid_input:tables.3.label')
    expect(save({ ...input, rooms: [{ id: input.rooms[0]!.id, name: { fr: ' ' } }] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(labels(listFloor(h.t.db))).toEqual(['T4', 'T5', 'T6'])
    expect(labels(ok(save(withTable(input))))).toEqual(['T4', 'T5', 'T6', 'T9'])
  })

  it('needs settings.manage', () => {
    expect(code(save(current(), h.cashier))).toBe('forbidden')
  })

  it('refuses to remove a table that has an open order, and changes nothing', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t5, covers: 2 }))
    const input = current()
    const result = save({ ...withTable(input), tables: withTable(input).tables.filter((t) => t.id !== h.fx.tables.t5) })
    expect(result).toMatchObject({ ok: false, error: { code: 'table_in_use', params: { tableId: h.fx.tables.t5, label: 'T5' } } })
    expect(labels(listFloor(h.t.db))).toEqual(['T4', 'T5', 'T6'])
    // A parked order still holds its table; once it is paid and closed the table can go.
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(labels(ok(save({ ...input, tables: input.tables.filter((t) => t.id !== h.fx.tables.t5) })))).toEqual(['T4', 'T6'])
  })

  it('a table nothing ever pointed at is deleted; one the history points at is deactivated and keeps its label', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    const input = current()
    const saved = ok(save({ ...input, tables: input.tables.filter((t) => t.id === h.fx.tables.t5) }))
    expect(labels(saved)).toEqual(['T5'])
    expect(saved.tables.find((t) => t.id === h.fx.tables.t4)).toMatchObject({ label: 'T4', active: false })
    expect(saved.tables.some((t) => t.id === h.fx.tables.t6)).toBe(false)
    expect(ok(h.orders.getOrder(h.cashier, order.id)).tableLabel).toBe('T4')
  })

  it('a room that is left out goes, its tables with it; the tables kept for the history move to the first room', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    const hall = { id: 'room-hall', name: { fr: 'Salon' } }
    const saved = ok(save({ rooms: [hall], tables: [{ id: 'hall-1', roomId: hall.id, label: '1', shape: 'rect', x: 0, y: 0, w: 200, h: 100, seats: 6 }] }))
    expect(saved.rooms.map((r) => r.id)).toEqual(['room-hall'])
    expect(saved.tables.filter((t) => t.active).map((t) => t.id)).toEqual(['hall-1'])
    expect(saved.tables.find((t) => t.id === h.fx.tables.t4)).toMatchObject({ roomId: 'room-hall', active: false })
  })

  it('no room left is refused while the history needs a table, and a room with an open table cannot be dropped', () => {
    const order = ok(h.orders.openOrder(h.cashier, { type: 'dine_in', tableId: h.fx.tables.t4, covers: 2 }))
    expect(code(save({ rooms: [], tables: [] }))).toBe('table_in_use')
    ok(h.orders.addLine(h.cashier, order.id, { productId: h.fx.products.the, qtyMilli: 1000, modifierIds: [], note: '' }))
    ok(h.orders.addPayment(h.cashier, order.id, { methodCode: 'cash', amountCents: 1200 }))
    ok(h.tickets.closeOrder(h.cashier, order.id))
    expect(save({ rooms: [], tables: [] })).toMatchObject({ ok: false, error: { code: 'invalid_input', params: { field: 'rooms' } } })
    expect(h.count('rooms')).toBe(1)
    expect(labels(listFloor(h.t.db))).toEqual(['T4', 'T5', 'T6'])
  })

  it('an empty plan with no history is a plan without rooms', () => {
    const saved = ok(save({ rooms: [], tables: [] }))
    expect(saved).toEqual({ rooms: [], tables: [] })
  })
})
