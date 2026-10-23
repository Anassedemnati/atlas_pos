import type { TicketDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { requirePermission, type Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { AppErrorException } from '../../errors'
import { ensureDay } from '../days/day'
import { moveStock, type Sales } from '../orders/context'
import { reasonOf } from '../orders/inputs'
import { attemptSync, invalidInput } from '../users/outcome'
import { queueReceipt, ticketHeader } from './close'
import { creditSnapshot } from './snapshot'

export interface CancelUseCases {
  /**
   * Cancels a closed sale with a credit note (`AV-000001`...): needs `ticket.cancel` and a reason. The
   * credit note carries the sale's figures negated, references it, and counts in the business day open
   * now (opening one after a Z). The stock it sold comes back. A sale is cancelled once
   * (`already_cancelled`); a credit note is not a sale (`not_a_sale`). The sale itself never changes.
   */
  cancelTicket(session: Session, ticketId: string, reason: string): Result<TicketDto>
  /**
   * Needs `ticket.reprint`: the reprint counter goes up and the ticket is printed again, marked DUPLICATA.
   * It counts in the open business day (opening one after a Z), whose Z reports it.
   */
  reprintTicket(session: Session, ticketId: string): Result<TicketDto>
}

export function createCancelUseCases(ctx: Sales): CancelUseCases {
  const { uow } = ctx

  const load = (ticketId: string): TicketDto => {
    const ticket = typeof ticketId === 'string' ? ctx.tickets.get(ticketId) : undefined
    if (!ticket) throw invalidInput('ticketId', 'unknown ticket')
    return ticket
  }

  function cancel(session: Session, ticketId: string, rawReason: string): TicketDto {
    requirePermission(session, 'ticket.cancel')
    const reason = reasonOf(rawReason)
    return uow.run((tx) => {
      const sale = load(ticketId)
      if (sale.kind !== 'sale') throw new AppErrorException('not_a_sale')
      if (ctx.tickets.creditOf(sale.id) !== undefined) throw new AppErrorException('already_cancelled')
      const day = ensureDay(tx, ctx, session.userId)
      const header = ticketHeader(tx, ctx, session, 'credit', day.id)
      const snapshot = creditSnapshot(sale.snapshot, header, { ticketId: sale.id, reason })
      const credit: TicketDto = {
        id: newId(),
        kind: 'credit',
        number: header.number,
        label: header.label,
        orderId: sale.orderId,
        dayId: day.id,
        refTicketId: sale.id,
        closedAt: header.closedAt,
        userId: session.userId,
        totalCents: snapshot.totals.totalCents,
        reprintCount: 0,
        snapshot
      }
      ctx.tickets.insert(tx, credit)
      // What the sale took out of the stock, as it was sold (the snapshot), comes back.
      for (const line of sale.snapshot.lines) moveStock(tx, ctx, line, 1)
      appendEvent(
        tx.db,
        {
          type: 'ticket.cancelled',
          entity: 'ticket',
          entityId: credit.id,
          userId: session.userId,
          data: { refTicketId: sale.id, label: credit.label, reason, totalCents: credit.totalCents, dayId: day.id }
        },
        tx.clock
      )
      queueReceipt(
        tx,
        ctx,
        credit.id,
        sale.snapshot.payments.map((p) => p.methodCode)
      )
      tx.events.push({ type: 'ticket.closed', ticketId: credit.id })
      return credit
    })
  }

  function reprint(session: Session, ticketId: string): TicketDto {
    requirePermission(session, 'ticket.reprint')
    return uow.run((tx) => {
      const ticket = load(ticketId)
      // The reprint counts in the day open now, opened here after a Z, so that its Z reports it.
      const day = ensureDay(tx, ctx, session.userId)
      ctx.tickets.addReprint(tx, ticket.id)
      appendEvent(
        tx.db,
        {
          type: 'ticket.reprinted',
          entity: 'ticket',
          entityId: ticket.id,
          userId: session.userId,
          data: { label: ticket.label, dayId: day.id }
        },
        tx.clock
      )
      ctx.spooler.enqueue(tx, { target: { role: 'receipt' }, kind: 'receipt', payload: { ticketId: ticket.id, duplicate: true } })
      return load(ticket.id)
    })
  }

  return {
    cancelTicket: (session, ticketId, reason) => attemptSync(() => cancel(session, ticketId, reason)),
    reprintTicket: (session, ticketId) => attemptSync(() => reprint(session, ticketId))
  }
}
