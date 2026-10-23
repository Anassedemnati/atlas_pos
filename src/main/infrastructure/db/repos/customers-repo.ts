import type { CustomerDto } from '@shared/dto'
import type { Database } from '../connection'
import type { Tx } from '../uow'

interface CustomerRow {
  id: string
  name: string
  phone: string
  address: string
  company_name: string
  ice: string
  is_company: number
  notes: string
  created_at: string
}

const toCustomer = (row: CustomerRow): CustomerDto => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  address: row.address,
  companyName: row.company_name,
  ice: row.ice,
  isCompany: row.is_company === 1,
  notes: row.notes,
  createdAt: row.created_at
})

/** `%` and `_` typed by the user are matched literally. */
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export interface CustomersRepo {
  get(id: string): CustomerDto | undefined
  /** Name, phone, company name or ICE containing `q` (case-insensitive for Latin letters), by name. */
  search(q: string, limit: number): CustomerDto[]
  /** Inserts or updates every field but `created_at`. */
  save(tx: Tx, customer: CustomerDto): void
}

export function createCustomersRepo(db: Database): CustomersRepo {
  return {
    get(id) {
      const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined
      return row ? toCustomer(row) : undefined
    },

    search(q, limit) {
      const like = likePattern(q)
      return (
        db
          .prepare(
            `SELECT * FROM customers
             WHERE name LIKE @like ESCAPE '\\' OR phone LIKE @like ESCAPE '\\' OR company_name LIKE @like ESCAPE '\\'
                OR ice LIKE @like ESCAPE '\\'
             ORDER BY name COLLATE NOCASE, id LIMIT @limit`
          )
          .all({ like, limit }) as CustomerRow[]
      ).map(toCustomer)
    },

    save(tx, c) {
      tx.db
        .prepare(
          `INSERT INTO customers (id, name, phone, address, company_name, ice, is_company, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = excluded.address,
             company_name = excluded.company_name, ice = excluded.ice, is_company = excluded.is_company,
             notes = excluded.notes`
        )
        .run(c.id, c.name, c.phone, c.address, c.companyName, c.ice, c.isCompany ? 1 : 0, c.notes, c.createdAt)
    }
  }
}
