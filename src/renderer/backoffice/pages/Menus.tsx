import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CatalogDto, MenuDto, ModifierGroupDto } from '@shared/dto'
import { formatMoney, parseMoney } from '@shared/money'
import type { LocalizedName } from '@shared/names'
import { Button, Select, Tabs, TextField, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { Drawer } from '../components/Drawer'
import { NamesFields } from '../components/NamesFields'
import { PageHeader } from '../components/PageHeader'
import { centsToInput, parseSignedMoney, useFormat } from '../format'

interface GroupDraft {
  id: string | null
  name: LocalizedName
  minSelect: string
  maxSelect: string
  modifiers: { id?: string; name: LocalizedName; price: string }[]
}

interface MenuDraft {
  productId: string | null
  courses: { name: LocalizedName; chooseCount: string; items: { productId: string; supplement: string }[] }[]
}

const blankModifier = () => ({ name: { fr: '' } as LocalizedName, price: '0,00' })

/** Option groups (sauce, cuisson, taille...) and set menus (courses with a choice of dishes). */
export function Menus() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const catalog = useQuery<CatalogDto>('/api/catalog')
  const [tab, setTab] = useState<'groups' | 'menus'>('groups')
  const [group, setGroup] = useState<GroupDraft | null>(null)
  const [menu, setMenu] = useState<MenuDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const data = catalog.data
  const products = data?.products ?? []
  const productName = (id: string): string => f.name(products.find((p) => p.id === id)?.name)

  const editGroup = (g: ModifierGroupDto) => {
    setError(null)
    setGroup({
      id: g.id,
      name: { ...g.name },
      minSelect: String(g.minSelect),
      maxSelect: String(g.maxSelect),
      modifiers: g.modifiers.map((m) => ({ id: m.id, name: { ...m.name }, price: centsToInput(m.priceDeltaCents) }))
    })
  }

  const saveGroup = async () => {
    if (!group) return
    const modifiers = group.modifiers.map((m) => ({ ...(m.id ? { id: m.id } : {}), name: m.name, priceDeltaCents: parseSignedMoney(m.price) }))
    if (group.name.fr.trim() === '' || modifiers.length === 0 || modifiers.some((m) => m.name.fr.trim() === '' || m.priceDeltaCents === null)) return setError(t('bo.menus.errors.group'))
    setError(null)
    const body = { name: group.name, minSelect: Number(group.minSelect) || 0, maxSelect: Number(group.maxSelect) || 1, modifiers }
    const result = group.id ? await api.call('PUT', `/api/catalog/modifier-groups/${group.id}`, body) : await api.call('POST', '/api/catalog/modifier-groups', body)
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setGroup(null)
    catalog.reload()
  }

  const editMenu = (m: MenuDto) => {
    setError(null)
    setMenu({
      productId: m.productId,
      courses: m.courses.map((c) => ({ name: { ...c.name }, chooseCount: String(c.chooseCount), items: c.items.map((i) => ({ productId: i.productId, supplement: centsToInput(i.supplementCents) })) }))
    })
  }

  const saveMenu = async () => {
    if (!menu || !menu.productId) return setError(t('bo.menus.errors.menu'))
    const courses = menu.courses.map((c) => ({
      name: c.name,
      chooseCount: Number(c.chooseCount) || 1,
      items: c.items.map((i) => ({ productId: i.productId, supplementCents: parseMoney(i.supplement) }))
    }))
    if (courses.length === 0 || courses.some((c) => c.name.fr.trim() === '' || c.items.length === 0 || c.items.some((i) => i.productId === '' || i.supplementCents === null))) return setError(t('bo.menus.errors.menu'))
    setError(null)
    const result = await api.call('POST', '/api/catalog/menus', { productId: menu.productId, courses })
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setMenu(null)
    catalog.reload()
  }

  const productOptions = products.map((p) => ({ value: p.id, label: f.name(p.name) }))
  const menuProductIds = new Set((data?.menus ?? []).map((m) => m.productId))

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.menus')}>
        {tab === 'groups' ? (
          <Button icon="plus" onClick={() => (setError(null), setGroup({ id: null, name: { fr: '' }, minSelect: '0', maxSelect: '1', modifiers: [blankModifier()] }))} data-testid="group-new">
            {t('bo.menus.newGroup')}
          </Button>
        ) : (
          <Button icon="plus" onClick={() => (setError(null), setMenu({ productId: null, courses: [{ name: { fr: '' }, chooseCount: '1', items: [] }] }))} data-testid="menu-new">
            {t('bo.menus.newMenu')}
          </Button>
        )}
      </PageHeader>
      <Tabs
        variant="segmented"
        value={tab}
        onChange={setTab}
        aria-label={t('bo.nav.menus')}
        tabs={[
          { id: 'groups', label: t('bo.menus.groups') },
          { id: 'menus', label: t('bo.menus.menus') }
        ]}
      />

      {tab === 'groups' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="groups-table">
            <thead>
              <tr>
                <th>{t('bo.products.name')}</th>
                <th>{t('bo.menus.choice')}</th>
                <th>{t('bo.menus.options')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.modifierGroups ?? []).map((g) => (
                <tr key={g.id}>
                  <td>
                    <button type="button" className="bo-rowlink" onClick={() => editGroup(g)}>
                      {f.name(g.name)}
                    </button>
                  </td>
                  <td>{t('bo.menus.minMax', { min: g.minSelect, max: g.maxSelect })}</td>
                  <td className="muted">{g.modifiers.map((m) => `${f.name(m.name)}${m.priceDeltaCents ? ` (${formatMoney(m.priceDeltaCents, f.lang)})` : ''}`).join(', ')}</td>
                </tr>
              ))}
              {(data?.modifierGroups ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="muted bo-empty">
                    {t('bo.menus.noGroups')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'menus' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="menus-table">
            <thead>
              <tr>
                <th>{t('bo.menus.menu')}</th>
                <th>{t('bo.menus.courses')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.menus ?? []).map((m) => (
                <tr key={m.id}>
                  <td>
                    <button type="button" className="bo-rowlink" onClick={() => editMenu(m)}>
                      {productName(m.productId)}
                    </button>
                  </td>
                  <td className="muted">{m.courses.map((c) => `${f.name(c.name)} (${c.items.length})`).join(' / ')}</td>
                </tr>
              ))}
              {(data?.menus ?? []).length === 0 && (
                <tr>
                  <td colSpan={2} className="muted bo-empty">
                    {t('bo.menus.noMenus')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={group !== null}
        onClose={() => setGroup(null)}
        title={group?.id ? t('bo.menus.editGroup') : t('bo.menus.newGroup')}
        testId="group-drawer"
        footer={
          <>
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setGroup(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void saveGroup()} data-testid="group-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {group && (
          <div className="stack">
            <NamesFields value={group.name} onChange={(name) => setGroup({ ...group, name })} />
            <div className="bo-grid-2">
              <TextField label={t('bo.menus.min')} inputMode="numeric" value={group.minSelect} onChange={(minSelect) => setGroup({ ...group, minSelect })} />
              <TextField label={t('bo.menus.max')} inputMode="numeric" value={group.maxSelect} onChange={(maxSelect) => setGroup({ ...group, maxSelect })} />
            </div>
            <h3 className="h3">{t('bo.menus.options')}</h3>
            {group.modifiers.map((m, index) => (
              <div key={m.id ?? `new-${index}`} className="bo-modifier">
                <TextField label={t('bo.names.fr')} value={m.name.fr} onChange={(fr) => setGroup({ ...group, modifiers: group.modifiers.map((x, i) => (i === index ? { ...x, name: { ...x.name, fr } } : x)) })} />
                <TextField label={t('bo.names.ar')} dir="rtl" value={m.name.ar ?? ''} onChange={(ar) => setGroup({ ...group, modifiers: group.modifiers.map((x, i) => (i === index ? { ...x, name: { ...x.name, ar } } : x)) })} />
                <TextField label={t('bo.names.en')} value={m.name.en ?? ''} onChange={(en) => setGroup({ ...group, modifiers: group.modifiers.map((x, i) => (i === index ? { ...x, name: { ...x.name, en } } : x)) })} />
                <TextField label={t('bo.menus.priceDelta')} inputMode="decimal" value={m.price} onChange={(price) => setGroup({ ...group, modifiers: group.modifiers.map((x, i) => (i === index ? { ...x, price } : x)) })} />
                <Button variant="ghost" icon="trash" aria-label={t('common.remove')} onClick={() => setGroup({ ...group, modifiers: group.modifiers.filter((_, i) => i !== index) })} />
              </div>
            ))}
            <Button variant="ghost" icon="plus" onClick={() => setGroup({ ...group, modifiers: [...group.modifiers, blankModifier()] })}>
              {t('bo.menus.addOption')}
            </Button>
            {error && <p className="error-text" role="alert">{error}</p>}
          </div>
        )}
      </Drawer>

      <Drawer
        open={menu !== null}
        onClose={() => setMenu(null)}
        title={t('bo.menus.menu')}
        testId="menu-drawer"
        footer={
          <>
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setMenu(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void saveMenu()} data-testid="menu-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {menu && (
          <div className="stack">
            <Select label={t('bo.menus.menuProduct')} value={menu.productId} onChange={(productId) => setMenu({ ...menu, productId })} options={productOptions.filter((o) => o.value === menu.productId || !menuProductIds.has(o.value))} />
            {menu.courses.map((course, ci) => (
              <div key={ci} className="bo-course">
                <NamesFields value={course.name} onChange={(name) => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, name } : c)) })} />
                <TextField label={t('bo.menus.chooseCount')} inputMode="numeric" value={course.chooseCount} onChange={(chooseCount) => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, chooseCount } : c)) })} />
                {course.items.map((item, ii) => (
                  <div key={ii} className="bo-modifier">
                    <Select label={t('bo.menus.dish')} value={item.productId || null} onChange={(productId) => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, items: c.items.map((x, j) => (j === ii ? { ...x, productId } : x)) } : c)) })} options={productOptions} />
                    <TextField label={t('bo.menus.supplement')} inputMode="decimal" value={item.supplement} onChange={(supplement) => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, items: c.items.map((x, j) => (j === ii ? { ...x, supplement } : x)) } : c)) })} />
                    <Button variant="ghost" icon="trash" aria-label={t('common.remove')} onClick={() => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, items: c.items.filter((_, j) => j !== ii) } : c)) })} />
                  </div>
                ))}
                <div className="cluster">
                  <Button variant="ghost" icon="plus" onClick={() => setMenu({ ...menu, courses: menu.courses.map((c, i) => (i === ci ? { ...c, items: [...c.items, { productId: '', supplement: '0,00' }] } : c)) })}>
                    {t('bo.menus.addDish')}
                  </Button>
                  {menu.courses.length > 1 && (
                    <Button variant="ghost" icon="trash" onClick={() => setMenu({ ...menu, courses: menu.courses.filter((_, i) => i !== ci) })}>
                      {t('bo.menus.removeCourse')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <Button variant="ghost" icon="plus" onClick={() => setMenu({ ...menu, courses: [...menu.courses, { name: { fr: '' }, chooseCount: '1', items: [] }] })}>
              {t('bo.menus.addCourse')}
            </Button>
            {error && <p className="error-text" role="alert">{error}</p>}
          </div>
        )}
      </Drawer>
    </div>
  )
}
