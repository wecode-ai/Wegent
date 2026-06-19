import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { getRuntimeConfig } from '@/config/runtime'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

const OUTLINED_LOGIN_BUTTON_CLASS =
  'h-11 w-full rounded-lg border border-border bg-background text-sm font-semibold text-text-primary hover:bg-muted'

function getRedirectTarget(): string {
  const search = new URLSearchParams(window.location.search)
  const queryRedirect = sanitizeRedirectPath(search.get('redirect'), ['/login', '/login/oidc'])
  const storedRedirect = sanitizeRedirectPath(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY), [
    '/login',
    '/login/oidc',
  ])
  return queryRedirect || storedRedirect || '/'
}

function buildOidcLoginUrl(apiBaseUrl: string, redirect: string, appBasePath: string): string {
  const params = new URLSearchParams()
  params.set('redirect', redirect)
  if (appBasePath) {
    params.set('frontend_base_path', appBasePath)
  }

  return `${apiBaseUrl}/auth/oidc/login?${params.toString()}`
}

export function LoginPage() {
  const { t } = useTranslation('common')
  const {
    login,
    user,
    isLoading: authLoading,
    getAdminPasswordSetupStatus,
    setupAdminPassword,
  } = useAuth()
  const config = useMemo(() => getRuntimeConfig(), [])
  const [formData, setFormData] = useState({
    user_name: '',
    password: '',
  })
  const [adminPasswordFormData, setAdminPasswordFormData] = useState({
    password: '',
    confirmPassword: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [showAdminPassword, setShowAdminPassword] = useState(false)
  const [showAdminPasswordConfirm, setShowAdminPasswordConfirm] = useState(false)
  const [adminPasswordSetupRequired, setAdminPasswordSetupRequired] = useState<boolean | null>(null)
  const [adminPasswordSetupStatusError, setAdminPasswordSetupStatusError] = useState(false)
  const [adminUsername, setAdminUsername] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isAdminPasswordSubmitting, setIsAdminPasswordSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminPasswordError, setAdminPasswordError] = useState<string | null>(null)
  const redirectTarget = getRedirectTarget()
  const showPasswordLogin = config.loginMode === 'password' || config.loginMode === 'all'
  const showOidcLogin = config.loginMode === 'oidc' || config.loginMode === 'all'

  useEffect(() => {
    if (!authLoading && user) {
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      navigateTo(redirectTarget)
    }
  }, [authLoading, redirectTarget, user])

  useEffect(() => {
    let cancelled = false

    async function loadAdminPasswordSetupStatus() {
      if (!showPasswordLogin) {
        setAdminPasswordSetupRequired(false)
        setAdminPasswordSetupStatusError(false)
        return
      }

      try {
        const status = await getAdminPasswordSetupStatus()
        if (!cancelled) {
          setAdminPasswordSetupRequired(status.required)
          setAdminUsername(status.admin_username)
          setAdminPasswordSetupStatusError(false)
        }
      } catch (err) {
        console.error('Failed to load admin password setup status:', err)
        if (!cancelled) {
          setAdminPasswordSetupRequired(null)
          setAdminPasswordSetupStatusError(true)
        }
      }
    }

    void loadAdminPasswordSetupStatus()

    return () => {
      cancelled = true
    }
  }, [getAdminPasswordSetupStatus, showPasswordLogin])

  useEffect(() => {
    if (config.loginMode === 'oidc') {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
      window.location.href = buildOidcLoginUrl(
        config.apiBaseUrl,
        redirectTarget,
        config.appBasePath
      )
    }
  }, [config.apiBaseUrl, config.appBasePath, config.loginMode, redirectTarget])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      await login(formData)
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      navigateTo(redirectTarget)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workbench.login_failed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleAdminPasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAdminPasswordError(null)

    if (adminPasswordFormData.password !== adminPasswordFormData.confirmPassword) {
      setAdminPasswordError(t('workbench.admin_password_mismatch'))
      return
    }

    setIsAdminPasswordSubmitting(true)
    try {
      await setupAdminPassword(adminPasswordFormData.password)
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      navigateTo(redirectTarget)
    } catch (err) {
      setAdminPasswordError(
        err instanceof Error ? err.message : t('workbench.admin_password_setup_failed')
      )
    } finally {
      setIsAdminPasswordSubmitting(false)
    }
  }

  function handleOidcLogin() {
    const redirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY) || redirectTarget
    window.location.href = buildOidcLoginUrl(config.apiBaseUrl, redirect, config.appBasePath)
  }

  if (config.loginMode === 'oidc') {
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold text-text-primary">{t('workbench.login_title')}</h1>
          <p className="mt-2 text-sm text-text-muted">{t('workbench.login_subtitle')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-8 py-8 shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
          {showPasswordLogin &&
            adminPasswordSetupRequired === null &&
            !adminPasswordSetupStatusError && (
              <div className="py-8 text-center text-sm text-text-muted" data-testid="login-loading">
                {t('workbench.loading_setup_status')}
              </div>
            )}
          {showPasswordLogin && adminPasswordSetupStatusError && (
            <div
              className="py-8 text-center text-sm text-red-600"
              data-testid="login-setup-status-error"
            >
              {t('workbench.admin_password_setup_status_failed')}
            </div>
          )}
          {showPasswordLogin && adminPasswordSetupRequired === true && (
            <form
              data-testid="admin-password-setup-form"
              className="space-y-5"
              onSubmit={handleAdminPasswordSubmit}
            >
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {t('workbench.admin_password_setup_title')}
                </h2>
                <p className="mt-2 text-sm text-text-muted">
                  {t('workbench.admin_password_setup_description')}
                </p>
              </div>
              <div
                className="rounded-lg border border-border bg-background px-4 py-3"
                data-testid="admin-username-summary"
              >
                <div className="text-xs font-medium text-text-muted">
                  {t('workbench.admin_username_label')}
                </div>
                <div
                  className="mt-1 font-mono text-sm font-semibold text-text-primary"
                  data-testid="admin-username-value"
                >
                  {adminUsername}
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  {t('workbench.admin_username_description')}
                </p>
              </div>
              <div>
                <label htmlFor="admin-password" className="text-sm font-medium text-text-secondary">
                  {t('workbench.admin_password')}
                </label>
                <div className="relative mt-2">
                  <input
                    id="admin-password"
                    name="admin-password"
                    data-testid="admin-password-input"
                    type={showAdminPassword ? 'text' : 'password'}
                    className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
                    value={adminPasswordFormData.password}
                    minLength={6}
                    required
                    autoComplete="new-password"
                    placeholder={t('workbench.admin_password_placeholder')}
                    onChange={event =>
                      setAdminPasswordFormData(current => ({
                        ...current,
                        password: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    data-testid="admin-password-visibility-button"
                    className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
                    onClick={() => setShowAdminPassword(current => !current)}
                    aria-label={t('workbench.toggle_admin_password_visibility')}
                  >
                    {showAdminPassword ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
              <div>
                <label
                  htmlFor="admin-password-confirm"
                  className="text-sm font-medium text-text-secondary"
                >
                  {t('workbench.admin_password_confirm')}
                </label>
                <div className="relative mt-2">
                  <input
                    id="admin-password-confirm"
                    name="admin-password-confirm"
                    data-testid="admin-password-confirm-input"
                    type={showAdminPasswordConfirm ? 'text' : 'password'}
                    className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
                    value={adminPasswordFormData.confirmPassword}
                    minLength={6}
                    required
                    autoComplete="new-password"
                    placeholder={t('workbench.admin_password_confirm_placeholder')}
                    onChange={event =>
                      setAdminPasswordFormData(current => ({
                        ...current,
                        confirmPassword: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    data-testid="admin-password-confirm-visibility-button"
                    className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
                    onClick={() => setShowAdminPasswordConfirm(current => !current)}
                    aria-label={t('workbench.toggle_admin_password_visibility')}
                  >
                    {showAdminPasswordConfirm ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
              {adminPasswordError && (
                <div className="text-sm text-red-600" data-testid="admin-password-error">
                  {adminPasswordError}
                </div>
              )}
              <button
                type="submit"
                data-testid="admin-password-submit-button"
                className={`${OUTLINED_LOGIN_BUTTON_CLASS} disabled:opacity-60`}
                disabled={isAdminPasswordSubmitting}
              >
                {isAdminPasswordSubmitting
                  ? t('workbench.admin_password_setting')
                  : t('workbench.admin_password_submit')}
              </button>
            </form>
          )}
          {showPasswordLogin && adminPasswordSetupRequired === false && (
            <form data-testid="login-form" className="space-y-5" onSubmit={handleSubmit}>
              <div>
                <label htmlFor="user_name" className="text-sm font-medium text-text-secondary">
                  {t('workbench.login_username')}
                </label>
                <input
                  id="user_name"
                  name="user_name"
                  data-testid="login-username-input"
                  className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-secondary"
                  value={formData.user_name}
                  autoComplete="username"
                  onChange={event =>
                    setFormData(current => ({ ...current, user_name: event.target.value }))
                  }
                />
              </div>
              <div>
                <label htmlFor="password" className="text-sm font-medium text-text-secondary">
                  {t('workbench.login_password')}
                </label>
                <div className="relative mt-2">
                  <input
                    id="password"
                    name="password"
                    data-testid="login-password-input"
                    type={showPassword ? 'text' : 'password'}
                    className="h-11 w-full rounded-lg border border-border bg-background px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
                    value={formData.password}
                    autoComplete="current-password"
                    onChange={event =>
                      setFormData(current => ({ ...current, password: event.target.value }))
                    }
                  />
                  <button
                    type="button"
                    data-testid="toggle-password-visibility-button"
                    className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-muted"
                    onClick={() => setShowPassword(current => !current)}
                    aria-label={t('workbench.toggle_password_visibility')}
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <button
                type="submit"
                data-testid="login-submit-button"
                className={`${OUTLINED_LOGIN_BUTTON_CLASS} disabled:opacity-60`}
                disabled={isSubmitting}
              >
                {isSubmitting ? t('workbench.logging_in') : t('workbench.login_action')}
              </button>
            </form>
          )}
          {showPasswordLogin && adminPasswordSetupRequired === false && showOidcLogin && (
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-text-muted">{t('workbench.login_or_continue')}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          {showOidcLogin && (!showPasswordLogin || adminPasswordSetupRequired === false) && (
            <button
              type="button"
              data-testid="oidc-login-button"
              className={OUTLINED_LOGIN_BUTTON_CLASS}
              onClick={handleOidcLogin}
            >
              {config.oidcLoginText || t('workbench.oidc_login')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
