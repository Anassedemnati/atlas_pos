import type { CustomerDto } from '@shared/dto'
import { newId } from '@shared/ids'
import type { Result } from '@shared/result'
import { z } from 'zod'
import type { Session } from '../../../domain/users/session'
import { appendEvent } from '../../../infrastructure/db/event-log'
import { parseInput } from '../catalog/input'
import { salesContext, type SalesDeps } from '../orders/context'
import { attemptSync, invalidInput } from '../users/outcome'

const CustomerInputSchema = z.strictObject({
  /** Absent for a new customer. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(500).optional(),
  companyName: z.string().trim().max(200).optional(),
  ice: z.string().trim().max(15).optional(),
  isCompany: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional()
})
export type CustomerInput = z.input<typeof CustomerInputSchema>

/** The ICE (identifiant commun de l'entreprise): 15 digits. */
const ICE = /^\d{15}$/
const SEARCH_LIMIT = 20

export interface CustomersService {
  /** Up to 20 customers whose name, phone, company name or ICE contains `q`; none for a blank query. */
  searchCustomers(session: Session, q: string): Result<CustomerDto[]>
  /**
   * Creates (no `id`) or edits a customer; on an edit a field left out is kept. A company (`isCompany`)
   * needs a 15-digit ICE (`invalid_input`, field `ice`), as an invoice prints it.
   */
  saveCustomer(session: Session, input: CustomerInput): Result<CustomerDto>
}

export function createCustomersService(deps: SalesDeps): CustomersService {
  const ctx = salesContext(deps)

  function save(session: Session, raw: CustomerInput): CustomerDto {
    const input = parseInput(CustomerInputSchema, raw)
    return ctx.uow.run((tx) => {
      const existing = input.id === undefined ? undefined : ctx.customers.get(input.id)
      if (input.id !== undefined && !existing) throw invalidInput('id', 'unknown customer')
      const base: CustomerDto = existing ?? {
        id: newId(),
        name: input.name,
        phone: '',
        address: '',
        companyName: '',
        ice: '',
        isCompany: false,
        notes: '',
        createdAt: tx.clock.now().toISOString()
      }
      const customer: CustomerDto = {
        ...base,
        name: input.name,
        phone: input.phone ?? base.phone,
        address: input.address ?? base.address,
        companyName: input.companyName ?? base.companyName,
        ice: input.ice ?? base.ice,
        isCompany: input.isCompany ?? base.isCompany,
        notes: input.notes ?? base.notes
      }
      if (customer.isCompany && !ICE.test(customer.ice)) throw invalidInput('ice', '15 digits')
      ctx.customers.save(tx, customer)
      appendEvent(
        tx.db,
        { type: 'customer.saved', entity: 'customer', entityId: customer.id, userId: session.userId, data: { created: !existing } },
        tx.clock
      )
      return customer
    })
  }

  return {
    searchCustomers: (_session, q) =>
      attemptSync(() => {
        const query = typeof q === 'string' ? q.trim() : ''
        return query === '' ? [] : ctx.customers.search(query, SEARCH_LIMIT)
      }),
    saveCustomer: (session, input) => attemptSync(() => save(session, input))
  }
}
