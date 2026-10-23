import type { customersChannels, daysChannels, ticketsChannels } from '@shared/ipc/sales'
import { overrideToken as token, type Handlers } from './context'

type SalesChannel = keyof typeof ticketsChannels | keyof typeof daysChannels | keyof typeof customersChannels

/** Closed tickets, business days (gate, X, Z), customers. */
export const salesHandlers: Handlers<SalesChannel> = {
  'tickets.cancel': ({ ticketId, reason }, ctx) => ctx.services().tickets.cancelTicket(ctx.session(), ticketId, reason),
  'tickets.reprint': ({ ticketId }, ctx) => ctx.services().tickets.reprintTicket(ctx.session(), ticketId),
  'days.current': (_input, ctx) => ctx.services().days.currentDay(ctx.session()),
  'days.gate': (_input, ctx) => ctx.services().days.dayGate(ctx.session()),
  'days.xReport': ({ dayId }, ctx) => ctx.services().days.xReport(ctx.session(), dayId),
  'days.close': ({ overrideTokenId }, ctx) => ctx.services().days.closeDay(ctx.session(), token(overrideTokenId)),
  'customers.search': ({ q }, ctx) => ctx.services().customers.searchCustomers(ctx.session(), q),
  'customers.get': ({ id }, ctx) => ctx.services().customers.getCustomer(ctx.session(), id),
  'customers.save': (input, ctx) => ctx.services().customers.saveCustomer(ctx.session(), input)
}
