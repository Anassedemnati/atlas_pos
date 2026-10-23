import { describe, expect, it } from 'vitest'
import { activeLines, paymentState, unsentLines } from '../../../src/main/domain/order/order'
import { errorCodeOf, makeLine } from '../../helpers/order'

describe('activeLines', () => {
  it('keeps the active lines, in order, and drops the void ones', () => {
    const a = makeLine({ id: 'a' })
    const b = makeLine({ id: 'b', status: 'void' })
    const c = makeLine({ id: 'c' })
    expect(activeLines([a, b, c])).toEqual([a, c])
    expect(activeLines([])).toEqual([])
  })
})

describe('unsentLines', () => {
  const lines = [
    makeLine({ id: 'sent', course: 0, sentAt: '2026-10-22T12:00:00.000Z' }),
    makeLine({ id: 'drink', course: 0 }),
    makeLine({ id: 'starter', course: 1 }),
    makeLine({ id: 'void', course: 1, status: 'void' }),
    makeLine({ id: 'main', course: 2 }),
    makeLine({ id: 'dessert', course: 3 })
  ]

  it('lists every active line the kitchen has not got yet', () => {
    expect(unsentLines(lines).map((l) => l.id)).toEqual(['drink', 'starter', 'main', 'dessert'])
  })

  it('stops at a course: "send next course" takes the courses up to it, and the lines without a course', () => {
    expect(unsentLines(lines, 1).map((l) => l.id)).toEqual(['drink', 'starter'])
    expect(unsentLines(lines, 2).map((l) => l.id)).toEqual(['drink', 'starter', 'main'])
    expect(unsentLines(lines, 0).map((l) => l.id)).toEqual(['drink'])
  })
})

describe('paymentState', () => {
  const card = (amountCents: number) => ({ methodCode: 'card', amountCents, tenderedCents: amountCents })
  const cash = (amountCents: number, tenderedCents: number) => ({ methodCode: 'cash', amountCents, tenderedCents })

  it('is all due before any payment', () => {
    expect(paymentState(27100, [])).toEqual({ paid: 0, due: 27100, change: 0 })
  })

  it('gives change for cash tendered above what was applied (card 100,00 + cash 171,00 applied, 200,00 handed over)', () => {
    expect(paymentState(27100, [card(10000), cash(17100, 20000)])).toEqual({ paid: 27100, due: 0, change: 2900 })
  })

  it('keeps what is still due after a part payment', () => {
    expect(paymentState(27100, [card(10000)])).toEqual({ paid: 10000, due: 17100, change: 0 })
    expect(paymentState(27100, [cash(5000, 5000)])).toEqual({ paid: 5000, due: 22100, change: 0 })
  })

  it('adds up the change of several cash payments', () => {
    expect(paymentState(3000, [cash(1000, 1500), cash(2000, 2500)])).toEqual({ paid: 3000, due: 0, change: 1000 })
  })

  it('treats any other method as non-cash: cheque and voucher give no change', () => {
    const cheque = { methodCode: 'cheque', amountCents: 5000, tenderedCents: 5000 }
    expect(paymentState(5000, [cheque])).toEqual({ paid: 5000, due: 0, change: 0 })
  })

  it('refuses a card payment above what is due', () => {
    expect(errorCodeOf(() => paymentState(27100, [card(30000)]))).toBe('overpay_non_cash')
    expect(errorCodeOf(() => paymentState(27100, [cash(20000, 20000), card(10000)]))).toBe('overpay_non_cash')
    expect(errorCodeOf(() => paymentState(0, [card(1)]))).toBe('overpay_non_cash')
  })

  it('refuses a cash amount applied above what is due: the amount is the applied part, the tendered is what was handed over', () => {
    expect(errorCodeOf(() => paymentState(27100, [card(10000), cash(20000, 20000)]))).toBe('invalid_payment')
  })

  it('refuses cash tendered below the amount applied', () => {
    expect(errorCodeOf(() => paymentState(27100, [cash(5000, 4000)]))).toBe('invalid_payment')
  })

  it('refuses amounts that are negative or not whole centimes', () => {
    expect(errorCodeOf(() => paymentState(27100, [card(-1)]))).toBe('invalid_payment')
    expect(errorCodeOf(() => paymentState(27100, [card(10.5)]))).toBe('invalid_payment')
    expect(errorCodeOf(() => paymentState(27100, [cash(1000, Number.NaN)]))).toBe('invalid_payment')
    expect(errorCodeOf(() => paymentState(-1, []))).toBe('invalid_payment')
  })
})
