import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CatalogDto, CategoryDto } from '@shared/dto'
import type { LocalizedName } from '@shared/names'
import { Button, ConfirmDialog, Toggle, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { Drawer } from '../components/Drawer'
import { NamesFields } from '../components/NamesFields'
import { PageHeader } from '../components/PageHeader'
import { Switch } from '../components/Switch'
import { useFormat } from '../format'

interface Draft {
  id: string | null
  name: LocalizedName
  color: string
  active: boolean
}

/** The categories of the till's tabs: name in three languages, colour, active. */
export function Categories() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const catalog = useQuery<CatalogDto>('/api/catalog')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [nameError, setNameError] = useState<string | undefined>()
  const [removing, setRemoving] = useState<CategoryDto | null>(null)
  const categories = catalog.data?.categories ?? []
  const counts = new Map<string, number>()
  for (const product of catalog.data?.products ?? []) counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1)

  const save = async () => {
    if (!draft) return
    if (draft.name.fr.trim() === '') return setNameError(t('bo.products.errors.name'))
    setNameError(undefined)
    const body = { name: draft.name, color: draft.color, active: draft.active }
    const result = draft.id ? await api.call('PUT', `/api/catalog/categories/${draft.id}`, body) : await api.call('POST', '/api/catalog/categories', body)
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setDraft(null)
    catalog.reload()
  }

  const toggle = async (category: CategoryDto, active: boolean) => {
    const result = await api.call('PUT', `/api/catalog/categories/${category.id}`, { name: category.name, color: category.color, active })
    if (result.ok) catalog.reload()
  }

  const remove = async () => {
    if (!removing) return
    const result = await api.call('DELETE', `/api/catalog/categories/${removing.id}`)
    setRemoving(null)
    if (!result.ok) return
    setDraft(null)
    catalog.reload()
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.categories')}>
        <Button icon="plus" onClick={() => (setNameError(undefined), setDraft({ id: null, name: { fr: '' }, color: '#0FA3A3', active: true }))} data-testid="category-new">
          {t('bo.categories.new')}
        </Button>
      </PageHeader>
      <div className="bo-table-wrap">
        <table className="bo-table" data-testid="categories-table">
          <thead>
            <tr>
              <th aria-label={t('bo.products.color')} />
              <th>{t('bo.products.name')}</th>
              <th className="bo-num">{t('bo.categories.products')}</th>
              <th>{t('bo.products.active')}</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id}>
                <td>
                  <span className="bo-swatch" style={{ background: category.color }} />
                </td>
                <td>
                  <button type="button" className="bo-rowlink" onClick={() => (setNameError(undefined), setDraft({ id: category.id, name: { ...category.name }, color: category.color, active: category.active }))}>
                    {f.name(category.name)}
                  </button>
                </td>
                <td className="bo-num">{counts.get(category.id) ?? 0}</td>
                <td>
                  <Switch checked={category.active} label={t('bo.products.active')} onChange={(active) => void toggle(category, active)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? t('bo.categories.edit') : t('bo.categories.new')}
        testId="category-drawer"
        footer={
          <>
            {draft?.id && (
              <Button variant="danger" size="lg" onClick={() => setRemoving(categories.find((c) => c.id === draft.id) ?? null)}>
                {t('common.delete')}
              </Button>
            )}
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void save()} data-testid="category-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="stack">
            <NamesFields value={draft.name} onChange={(name) => setDraft({ ...draft, name })} error={nameError} />
            <label className="field">
              <span className="field__label">{t('bo.products.color')}</span>
              <span className="bo-color">
                <input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value.toUpperCase() })} aria-label={t('bo.products.color')} />
              </span>
            </label>
            <Toggle label={t('bo.products.active')} checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={removing !== null}
        tone="danger"
        title={t('bo.categories.deleteTitle')}
        message={removing ? t('bo.categories.deleteMessage', { name: removing.name.fr }) : ''}
        confirmLabel={t('common.delete')}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  )
}
