// People the business deals with, outside the staff accounts: customers.

export interface CustomerDto {
  id: string
  name: string
  phone: string
  address: string
  companyName: string
  /** 15 digits for a company. */
  ice: string
  isCompany: boolean
  notes: string
  createdAt: string
}
