import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomerDto } from '@shared/dto'
import { invoke, useApi } from '../../app/api'
import { Button, EmptyState, Modal, TextField } from '../../ui'

export interface CustomerPickerProps {
  title?: string
  /** An invoice is made out to a company: only companies are listed, and a new customer is a company (name, 15-digit ICE, address). */
  requireCompany?: boolean
  onPick: (customer: CustomerDto) => void
  /** Offers "Retirer le client" (an order that has one). */
  onClear?: () => void
  onClose: () => void
}

/** The ICE (identifiant commun de l'entreprise): 15 digits. */
const ICE = /^\d{15}$/

/** Finds a customer by name, company, ICE or phone, or creates one. Shared by the invoice flow and the customer of an order. */
export function CustomerPicker({ title, requireCompany = false, onPick, onClear, onClose }: CustomerPickerProps) {
  const { t } = useTranslation()
  const api = useApi()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<CustomerDto[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [ice, setIce] = useState('')
  const [busy, setBusy] = useState(false)

  // The search runs a moment after the last key; a blank search lists nothing.
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void invoke('customers.search', { q }).then((result) => {
        if (current && result.ok) setFound(requireCompany ? result.value.filter((c) => c.isCompany && ICE.test(c.ice)) : result.value)
      })
    }, 200)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [q, requireCompany])

  const iceOk = ICE.test(ice)
  const ready = name.trim() !== '' && (!requireCompany || iceOk)

  const create = async () => {
    if (!ready || busy) return
    setBusy(true)
    const result = await api.call('customers.save', {
      name: name.trim(),
      phone: phone.trim(),
      address: address.trim(),
      ...(requireCompany ? { companyName: name.trim(), ice, isCompany: true } : {})
    })
    setBusy(false)
    if (result.ok) onPick(result.value)
  }

  return (
    <Modal open onClose={onClose} title={title ?? t('till.customer.title')} size="lg">
      {creating ? (
        <div className="stack" data-testid="customer-form">
          <TextField label={requireCompany ? t('till.customer.companyName') : t('till.customer.name')} value={name} onChange={setName} maxLength={200} autoFocus data-testid="customer-name" />
          {requireCompany && (
            <TextField
              label={t('till.customer.ice')}
              value={ice}
              onChange={(value) => setIce(value.replace(/\D/g, '').slice(0, 15))}
              inputMode="numeric"
              maxLength={15}
              error={ice !== '' && !iceOk ? t('till.customer.iceInvalid') : undefined}
              data-testid="customer-ice"
            />
          )}
          <TextField label={t('till.customer.address')} value={address} onChange={setAddress} maxLength={500} data-testid="customer-address" />
          <TextField label={t('till.customer.phone')} value={phone} onChange={setPhone} inputMode="tel" maxLength={40} data-testid="customer-phone" />
          <div className="cluster">
            <Button variant="secondary" size="lg" onClick={() => setCreating(false)}>
              {t('till.customer.backToSearch')}
            </Button>
            <Button size="lg" disabled={!ready || busy} onClick={() => void create()} data-testid="customer-create">
              {t('till.customer.create')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack" data-testid="customer-picker">
          <TextField label={t('till.customer.search')} hideLabel icon="search" value={q} onChange={setQ} placeholder={t('till.customer.searchPlaceholder')} autoFocus data-testid="customer-search" />
          {q.trim() !== '' && found.length === 0 ? (
            <EmptyState icon="search" title={t('till.customer.none')} />
          ) : (
            <ul className="plain-list" data-testid="customer-results">
              {found.map((customer) => (
                <li key={customer.id}>
                  <button type="button" className="order-row" onClick={() => onPick(customer)} data-testid={`customer-${customer.id}`}>
                    <strong className="grow">{customer.companyName || customer.name}</strong>
                    {customer.isCompany && customer.ice && (
                      <span className="muted">
                        {t('till.customer.iceShort')} {customer.ice}
                      </span>
                    )}
                    {customer.phone && <span className="muted">{customer.phone}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="cluster">
            <Button variant="secondary" size="lg" icon="plus" onClick={() => setCreating(true)} data-testid="customer-new">
              {t('till.customer.new')}
            </Button>
            {onClear && (
              <Button variant="secondary" size="lg" onClick={onClear} data-testid="customer-clear">
                {t('till.customer.clear')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
