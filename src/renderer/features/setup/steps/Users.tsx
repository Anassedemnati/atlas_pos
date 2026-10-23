import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { pickName } from '@shared/names'
import { PERMISSIONS } from '@shared/permissions'
import type { UserDraft } from '@shared/setup/draft'
import { currentLanguage } from '../../../app/i18n'
import { Button, Icon, Select, TextField } from '../../../ui'
import { Banner } from '../components/Banner'
import { Section } from '../components/Section'
import { useWizard } from '../wizard-context'

/** A profile that holds every permission is a manager (the main process applies the same rule). */
const isManagerProfile = (permissions: readonly string[]): boolean => PERMISSIONS.every((permission) => permissions.includes(permission))

const digits = (value: string): string => value.replace(/\D/g, '').slice(0, 6)

/** Step 5: the manager (PIN, back office login), the staff, and the technician code typed twice. */
export function Users() {
  const { t } = useTranslation()
  const { draft, templates, profile, edit, errors, techConfirm, setTechConfirm } = useWizard()
  const template = templates.find((item) => item.id === draft.businessType)
  const profiles = (draft.catalogSource === 'profile' && profile ? profile.profiles : template?.profiles) ?? []
  const managerProfile = profiles.find((item) => isManagerProfile(item.permissions)) ?? profiles[0]
  const staffProfiles = profiles.filter((item) => item !== managerProfile)
  const lang = currentLanguage()

  // The manager is always the first user: the form for it exists from the start.
  useEffect(() => {
    if (draft.users.length === 0 && managerProfile) {
      edit({ users: [{ displayName: '', pin: '', profileCode: managerProfile.code, username: '', password: '' }] })
    }
  }, [draft.users.length, managerProfile, edit])

  const manager = draft.users[0]
  const staff = draft.users.slice(1)

  const change = (index: number, patch: Partial<UserDraft>) =>
    edit((state) => ({ users: state.users.map((user, i) => (i === index ? { ...user, ...patch } : user)) }))

  const addStaff = () =>
    edit((state) => ({ users: [...state.users, { displayName: '', pin: '', profileCode: (staffProfiles.find((item) => item.code === 'caissier') ?? staffProfiles[0])?.code ?? '' }] }))

  const removeStaff = (index: number) => edit((state) => ({ users: state.users.filter((_user, i) => i !== index) }))

  return (
    <div className="stack wiz-stack">
      {errors['users'] && (
        <Banner tone="warning">
          <span className="wiz__error-anchor">{errors['users']}</span>
        </Banner>
      )}
      <Section title={t('setupWizard.users.manager')} hint={t('setupWizard.users.managerHint', { profile: managerProfile ? pickName(managerProfile.name, lang) : '' })}>
        {manager && (
          <div className="wiz-form">
            <TextField label={`${t('setupWizard.users.name')} *`} value={manager.displayName} onChange={(value) => change(0, { displayName: value })} error={errors['users.0.displayName']} maxLength={60} />
            <TextField
              label={`${t('setupWizard.users.pin')} *`}
              hint={t('setupWizard.users.pinHint')}
              value={manager.pin}
              onChange={(value) => change(0, { pin: digits(value) })}
              error={errors['users.0.pin']}
              inputMode="numeric"
              maxLength={6}
            />
            <TextField
              label={`${t('setupWizard.users.username')} *`}
              hint={t('setupWizard.users.usernameHint')}
              value={manager.username ?? ''}
              onChange={(value) => change(0, { username: value })}
              error={errors['users.0.username']}
              keyboard="azerty"
              autoCapitalize="none"
              maxLength={200}
            />
            <TextField
              label={`${t('setupWizard.users.password')} *`}
              hint={t('setupWizard.users.passwordHint')}
              type="password"
              value={manager.password ?? ''}
              onChange={(value) => change(0, { password: value })}
              error={errors['users.0.password']}
              keyboard="azerty"
              autoComplete="new-password"
              maxLength={200}
            />
          </div>
        )}
      </Section>

      <Section
        title={t('setupWizard.users.staff')}
        hint={t('setupWizard.users.staffHint')}
        end={
          <Button variant="ghost" icon="plus" onClick={addStaff} disabled={staffProfiles.length === 0} data-testid="add-staff">
            {t('setupWizard.users.addStaff')}
          </Button>
        }
      >
        {staff.length === 0 ? (
          <p className="muted">{t('setupWizard.users.noStaff')}</p>
        ) : (
          <ul className="wiz-staff">
            {staff.map((user, offset) => {
              const index = offset + 1
              return (
                <li key={index} className="wiz-staff__row">
                  <TextField label={t('setupWizard.users.name')} value={user.displayName} onChange={(value) => change(index, { displayName: value })} error={errors[`users.${index}.displayName`]} maxLength={60} />
                  <TextField label={t('setupWizard.users.pin')} value={user.pin} onChange={(value) => change(index, { pin: digits(value) })} error={errors[`users.${index}.pin`]} inputMode="numeric" maxLength={6} />
                  <Select
                    label={t('setupWizard.users.profile')}
                    value={user.profileCode || null}
                    options={staffProfiles.map((item) => ({ value: item.code, label: pickName(item.name, lang) }))}
                    onChange={(value) => change(index, { profileCode: value })}
                    error={errors[`users.${index}.profileCode`]}
                  />
                  <Button variant="secondary" icon="trash" aria-label={t('common.remove')} onClick={() => removeStaff(index)} />
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section title={t('setupWizard.users.technician')} hint={t('setupWizard.users.technicianHint')}>
        <div className="wiz-form">
          <TextField
            label={`${t('setupWizard.users.techCode')} *`}
            hint={t('setupWizard.users.techCodeHint')}
            type="password"
            value={draft.technicianCode}
            onChange={(value) => edit({ technicianCode: value })}
            error={errors['technicianCode']}
            keyboard="azerty"
            autoComplete="off"
            maxLength={64}
          />
          <TextField
            label={`${t('setupWizard.users.techConfirm')} *`}
            type="password"
            value={techConfirm}
            onChange={setTechConfirm}
            error={errors['techConfirm']}
            keyboard="azerty"
            autoComplete="off"
            maxLength={64}
          />
        </div>
        <p className="wiz-note">
          <Icon name="lock" size={22} />
          {t('setupWizard.users.techNote')}
        </p>
      </Section>
    </div>
  )
}
