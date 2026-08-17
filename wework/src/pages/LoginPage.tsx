import { useEffect, useMemo, useState } from 'react'
import {
  AdminPasswordSetupForm,
  PasswordLoginForm,
  OUTLINED_LOGIN_BUTTON_CLASS,
} from '@/components/auth/LoginForms'
import { getRuntimeConfig } from '@/config/runtime'
import { isAdminPasswordSetupRequiredError } from '@/features/auth/adminPasswordSetup'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

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
    adminPasswordSetupRequired,
    adminUsername,
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isAdminPasswordSubmitting, setIsAdminPasswordSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminPasswordError, setAdminPasswordError] = useState<string | null>(null)
  const redirectTarget = getRedirectTarget()
  const showPasswordLogin = config.loginMode === 'password' || config.loginMode === 'all'
  const showOidcLogin = config.loginMode === 'oidc' || config.loginMode === 'all'
  const isResolvingInitialUserState = authLoading && !user

  useEffect(() => {
    if (!authLoading && user) {
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      navigateTo(redirectTarget)
    }
  }, [authLoading, redirectTarget, user])

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
      if (isAdminPasswordSetupRequiredError(err)) {
        return
      }
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
          <h1 className="heading-xl text-text-primary">{t('workbench.login_title')}</h1>
          <p className="mt-2 text-sm text-text-muted">{t('workbench.login_subtitle')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-8 py-8 shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
          {showPasswordLogin && isResolvingInitialUserState && (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="login-loading">
              {t('workbench.loading_setup_status')}
            </div>
          )}
          {showPasswordLogin && !isResolvingInitialUserState && adminPasswordSetupRequired && (
            <AdminPasswordSetupForm
              adminUsername={adminUsername}
              value={adminPasswordFormData}
              error={adminPasswordError}
              submitting={isAdminPasswordSubmitting}
              onChange={setAdminPasswordFormData}
              onSubmit={handleAdminPasswordSubmit}
            />
          )}
          {showPasswordLogin && !isResolvingInitialUserState && !adminPasswordSetupRequired && (
            <PasswordLoginForm
              value={formData}
              error={error}
              submitting={isSubmitting}
              onChange={setFormData}
              onSubmit={handleSubmit}
            />
          )}
          {showPasswordLogin &&
            !isResolvingInitialUserState &&
            !adminPasswordSetupRequired &&
            showOidcLogin && (
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-text-muted">{t('workbench.login_or_continue')}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
          {showOidcLogin &&
            (!showPasswordLogin ||
              (!isResolvingInitialUserState && !adminPasswordSetupRequired)) && (
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
