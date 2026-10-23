import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StaffDto, StaffProfileDto, StaffUserDto } from '@shared/dto'
import type { Lang, LocalizedName } from '@shared/names'
import { PERMISSIONS, type Permission } from '@shared/permissions'
import { Button, Select, Tabs, TextField, Toggle, useToast } from '../../ui'
import { useApi, useQuery } from '../api'
import { Drawer } from '../components/Drawer'
import { NamesFields } from '../components/NamesFields'
import { PageHeader } from '../components/PageHeader'
import { Switch } from '../components/Switch'
import { useFormat } from '../format'

const MIN_PASSWORD = 8

interface UserDraft {
  id: string | null
  displayName: string
  profileId: string
  username: string
  password: string
  pin: string
  lang: Lang
  active: boolean
}

interface ProfileDraft {
  id: string | null
  name: LocalizedName
  permissions: Permission[]
  /** Percent, as typed. */
  maxDiscount: string
}

/** Staff accounts (till PIN, optional back office login) and permission profiles. */
export function Users() {
  const { t } = useTranslation()
  const f = useFormat()
  const api = useApi()
  const toast = useToast()
  const staff = useQuery<StaffDto>('/api/users')
  const [tab, setTab] = useState<'users' | 'profiles'>('users')
  const [user, setUser] = useState<UserDraft | null>(null)
  const [profile, setProfile] = useState<ProfileDraft | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const profiles = staff.data?.profiles ?? []
  const profileName = (id: string): string => f.name(profiles.find((p) => p.id === id)?.name)

  const editUser = (u: StaffUserDto) => {
    setErrors({})
    setUser({ id: u.id, displayName: u.displayName, profileId: u.profileId, username: u.username ?? '', password: '', pin: '', lang: u.lang, active: u.active })
  }

  const saveUser = async () => {
    if (!user) return
    const next: Record<string, string> = {}
    if (user.displayName.trim() === '') next['displayName'] = t('bo.users.errors.name')
    if (!user.id && !/^\d{4,6}$/.test(user.pin)) next['pin'] = t('bo.users.errors.pin')
    if (user.id && user.pin !== '' && !/^\d{4,6}$/.test(user.pin)) next['pin'] = t('bo.users.errors.pin')
    const username = user.username.trim()
    if (username !== '' && username.length < 3) next['username'] = t('bo.users.errors.username')
    if (user.password !== '' && user.password.length < MIN_PASSWORD) next['password'] = t('bo.users.errors.password', { min: MIN_PASSWORD })
    if (username !== '' && !user.id && user.password === '') next['password'] = t('bo.users.errors.password', { min: MIN_PASSWORD })
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const body = {
      displayName: user.displayName.trim(),
      profileId: user.profileId,
      lang: user.lang,
      active: user.active,
      ...(user.pin !== '' ? { pin: user.pin } : {}),
      username: username === '' ? null : username,
      ...(user.password !== '' ? { password: user.password } : {})
    }
    const result = user.id ? await api.call('PUT', `/api/users/${user.id}`, body) : await api.call('POST', '/api/users', body)
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setUser(null)
    staff.reload()
  }

  const toggleUser = async (u: StaffUserDto, active: boolean) => {
    const result = await api.call('PUT', `/api/users/${u.id}`, { displayName: u.displayName, profileId: u.profileId, active })
    if (result.ok) staff.reload()
  }

  const editProfile = (p: StaffProfileDto) => setProfile({ id: p.id, name: { ...p.name }, permissions: [...p.permissions], maxDiscount: String(p.maxDiscountBp / 100).replace('.', ',') })

  const saveProfile = async () => {
    if (!profile) return
    const percent = Number(profile.maxDiscount.replace(',', '.'))
    if (profile.name.fr.trim() === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) return setErrors({ profile: t('bo.users.errors.profile') })
    setErrors({})
    const body = { name: profile.name, permissions: profile.permissions, maxDiscountBp: Math.round(percent * 100) }
    const result = profile.id ? await api.call('PUT', `/api/profiles/${profile.id}`, body) : await api.call('POST', '/api/profiles', body)
    if (!result.ok) return
    toast.success(t('bo.saved'))
    setProfile(null)
    staff.reload()
  }

  return (
    <div className="stack">
      <PageHeader title={t('bo.nav.users')}>
        {tab === 'users' ? (
          <Button icon="plus" onClick={() => (setErrors({}), setUser({ id: null, displayName: '', profileId: profiles[0]?.id ?? '', username: '', password: '', pin: '', lang: 'fr', active: true }))} disabled={profiles.length === 0} data-testid="user-new">
            {t('bo.users.new')}
          </Button>
        ) : (
          <Button icon="plus" onClick={() => (setErrors({}), setProfile({ id: null, name: { fr: '' }, permissions: [], maxDiscount: '0' }))} data-testid="profile-new">
            {t('bo.users.newProfile')}
          </Button>
        )}
      </PageHeader>
      <Tabs
        variant="segmented"
        value={tab}
        onChange={setTab}
        aria-label={t('bo.nav.users')}
        tabs={[
          { id: 'users', label: t('bo.users.users') },
          { id: 'profiles', label: t('bo.users.profiles') }
        ]}
      />

      {tab === 'users' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="users-table">
            <thead>
              <tr>
                <th>{t('bo.users.name')}</th>
                <th>{t('bo.users.username')}</th>
                <th>{t('bo.users.profile')}</th>
                <th>{t('common.language')}</th>
                <th>{t('bo.products.active')}</th>
              </tr>
            </thead>
            <tbody>
              {(staff.data?.users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    <button type="button" className="bo-rowlink" onClick={() => editUser(u)}>
                      {u.displayName}
                    </button>
                  </td>
                  <td>{u.username ?? <span className="muted">{t('bo.users.tillOnly')}</span>}</td>
                  <td>{profileName(u.profileId)}</td>
                  <td>{u.lang.toUpperCase()}</td>
                  <td>
                    <Switch checked={u.active} label={t('bo.products.active')} onChange={(active) => void toggleUser(u, active)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'profiles' && (
        <div className="bo-table-wrap">
          <table className="bo-table" data-testid="profiles-table">
            <thead>
              <tr>
                <th>{t('bo.users.profile')}</th>
                <th>{t('bo.users.permissions')}</th>
                <th className="bo-num">{t('bo.users.maxDiscount')}</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button type="button" className="bo-rowlink" onClick={() => (setErrors({}), editProfile(p))}>
                      {f.name(p.name)}
                    </button>
                  </td>
                  <td className="muted">{t('bo.users.permissionCount', { count: p.permissions.length, total: PERMISSIONS.length })}</td>
                  <td className="bo-num">{p.maxDiscountBp / 100} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={user !== null}
        onClose={() => setUser(null)}
        title={user?.id ? t('bo.users.edit') : t('bo.users.new')}
        testId="user-drawer"
        footer={
          <>
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setUser(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void saveUser()} data-testid="user-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {user && (
          <div className="stack">
            <TextField label={t('bo.users.name')} value={user.displayName} onChange={(displayName) => setUser({ ...user, displayName })} error={errors['displayName']} data-testid="user-name" />
            <Select label={t('bo.users.profile')} value={user.profileId} onChange={(profileId) => setUser({ ...user, profileId })} options={profiles.map((p) => ({ value: p.id, label: f.name(p.name) }))} />
            <TextField label={user.id ? t('bo.users.pinKeep') : t('bo.users.pin')} type="password" inputMode="numeric" value={user.pin} onChange={(pin) => setUser({ ...user, pin })} error={errors['pin']} hint={t('bo.users.pinHint')} autoComplete="new-password" data-testid="user-pin" />
            <h3 className="h3">{t('bo.users.backofficeAccess')}</h3>
            <TextField label={t('bo.users.username')} value={user.username} onChange={(username) => setUser({ ...user, username })} error={errors['username']} hint={t('bo.users.usernameHint')} autoComplete="off" data-testid="user-username" />
            <TextField label={user.id ? t('bo.users.passwordKeep') : t('bo.users.password')} type="password" value={user.password} onChange={(password) => setUser({ ...user, password })} error={errors['password']} hint={t('bo.users.passwordHint', { min: MIN_PASSWORD })} autoComplete="new-password" data-testid="user-password" />
            <Select label={t('common.language')} value={user.lang} onChange={(lang) => setUser({ ...user, lang })} options={(['fr', 'ar', 'en'] as const).map((lang) => ({ value: lang, label: t(`lang.${lang}`) }))} />
            <Toggle label={t('bo.products.active')} checked={user.active} onChange={(active) => setUser({ ...user, active })} />
          </div>
        )}
      </Drawer>

      <Drawer
        open={profile !== null}
        onClose={() => setProfile(null)}
        title={t('bo.users.profile')}
        testId="profile-drawer"
        footer={
          <>
            <span className="grow" />
            <Button variant="secondary" size="lg" onClick={() => setProfile(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="lg" onClick={() => void saveProfile()} data-testid="profile-save">
              {t('common.save')}
            </Button>
          </>
        }
      >
        {profile && (
          <div className="stack">
            <NamesFields value={profile.name} onChange={(name) => setProfile({ ...profile, name })} />
            <TextField label={t('bo.users.maxDiscountPct')} inputMode="decimal" value={profile.maxDiscount} onChange={(maxDiscount) => setProfile({ ...profile, maxDiscount })} error={errors['profile']} />
            <h3 className="h3">{t('bo.users.permissions')}</h3>
            {PERMISSIONS.map((permission) => (
              <Toggle
                key={permission}
                label={t(`bo.permissions.${permission}`)}
                checked={profile.permissions.includes(permission)}
                onChange={(on) => setProfile({ ...profile, permissions: on ? [...profile.permissions, permission] : profile.permissions.filter((p) => p !== permission) })}
              />
            ))}
          </div>
        )}
      </Drawer>
    </div>
  )
}
