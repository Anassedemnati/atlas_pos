import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfoDto } from '@shared/dto/backoffice'
import { errorMessage } from '../../app/api'
import { LANGS, setLanguage } from '../../app/i18n'
import { Button, Card, Logo, TextField } from '../../ui'
import { http } from '../api'

/** The sign-in: username and password of a user whose profile holds the back office permission. */
export function Login({ onSignedIn }: { onSignedIn: (info: SessionInfoDto) => void }) {
  const { t, i18n } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    const result = await http<SessionInfoDto>('POST', '/api/auth/login', { username, password })
    setBusy(false)
    if (result.ok) {
      setPassword('')
      return onSignedIn(result.value)
    }
    setPassword('')
    setMessage(errorMessage(result.error))
  }

  return (
    <div className="bo-login">
      <Card padding="lg" className="bo-login__card">
        <form className="stack" onSubmit={(event) => void submit(event)} data-testid="login-form">
          <div className="bo-login__brand">
            <Logo />
          </div>
          <h1 className="h2">{t('bo.login.title')}</h1>
          <p className="muted">{t('bo.login.hint')}</p>
          <TextField label={t('bo.login.username')} value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" autoFocus data-testid="login-username" />
          <TextField label={t('bo.login.password')} type="password" value={password} onChange={setPassword} autoComplete="current-password" data-testid="login-password" />
          {message && (
            <p className="error-text" role="alert" data-testid="login-error">
              {message}
            </p>
          )}
          <Button type="submit" size="lg" block disabled={busy || username.trim() === '' || password === ''} data-testid="login-submit">
            {t('bo.login.submit')}
          </Button>
          <div className="bo-lang bo-lang--center" role="group" aria-label={t('common.language')}>
            {LANGS.map((lang) => (
              <button key={lang} type="button" className={i18n.language === lang ? 'bo-lang__item bo-lang__item--on' : 'bo-lang__item'} onClick={() => void setLanguage(lang)}>
                {t(`lang.${lang}`)}
              </button>
            ))}
          </div>
        </form>
      </Card>
    </div>
  )
}
