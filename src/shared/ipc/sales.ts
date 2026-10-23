import { z } from 'zod'
import type { CustomerDto, DayDto, DayGateDto, TicketDto, ZData } from '../dto'
import { def, id, none, text, tokenId } from './define'

/** Closed tickets (credit notes, duplicates). */
export const ticketsChannels = {
  'tickets.cancel': def<TicketDto>()(z.strictObject({ ticketId: id, reason: text }), 'session'),
  'tickets.reprint': def<TicketDto>()(z.strictObject({ ticketId: id }), 'session')
}

/** Business days: the gate, X and Z. */
export const daysChannels = {
  'days.current': def<DayDto | null>()(none, 'session'),
  'days.gate': def<DayGateDto>()(none, 'session'),
  /** The open day so far, or the stored Z of `dayId`. */
  'days.xReport': def<ZData>()(z.strictObject({ dayId: id.optional() }), 'session'),
  /** The Z. A user without `day.close` needs a manager's approval (`overrideTokenId`). */
  'days.close': def<{ zId: string; data: ZData }>()(z.strictObject({ overrideTokenId: tokenId }), 'session')
}

export const customersChannels = {
  'customers.search': def<CustomerDto[]>()(z.strictObject({ q: z.string().max(200) }), 'session'),
  'customers.get': def<CustomerDto | null>()(z.strictObject({ id }), 'session'),
  'customers.save': def<CustomerDto>()(
    z.strictObject({
      id: id.optional(),
      name: z.string(),
      phone: z.string().optional(),
      address: z.string().optional(),
      companyName: z.string().optional(),
      ice: z.string().optional(),
      isCompany: z.boolean().optional(),
      notes: z.string().optional()
    }),
    'session'
  )
}
