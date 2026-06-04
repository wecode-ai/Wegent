import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { getRuntimeConfig } from '@/config/runtime'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

function getRedirectTarget(): string {
  const search = new URLSearchParams(window.location.search)
  const queryRedirect = sanitizeRedirectPath(search.get('redirect'), ['/login', '/login/oidc'])
  const storedRedirect = sanitizeRedirectPath(
    sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY),
    ['/login', '/login/oidc'],
  )
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
  const { login, user, isLoading: authLoading } = useAuth()
  const config = useMemo(() => getRuntimeConfig(), [])
  const [formData, setFormData] = useState({
    user_name: 'admin',
    password: 'Wegent2025!',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    if (config.loginMode === 'oidc') {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
      window.location.href = buildOidcLoginUrl(
        config.apiBaseUrl,
        redirectTarget,
        config.appBasePath,
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
      setError(err instanceof Error ? err.message : t('workbench.login_failed', '登录失败'))
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleOidcLogin() {
    const redirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY) || redirectTarget
    window.location.href = buildOidcLoginUrl(
      config.apiBaseUrl,
      redirect,
      config.appBasePath,
    )
  }

  if (config.loginMode === 'oidc') {
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold text-text-primary">
            {t('workbench.login_title', '登录 Wework')}
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            {t('workbench.login_subtitle', '使用 Wegent 账号继续')}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-8 py-8 shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
          {showPasswordLogin && (
            <form data-testid="login-form" className="space-y-5" onSubmit={handleSubmit}>
              <div>
                <label htmlFor="user_name" className="text-sm font-medium text-text-secondary">
                  {t('workbench.login_username', '用户名')}
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
                  {t('workbench.login_password', '密码')}
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
                    aria-label={t('workbench.toggle_password_visibility', '切换密码可见性')}
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <button
                type="submit"
                data-testid="login-submit-button"
                className="h-11 w-full rounded-lg bg-text-primary text-sm font-semibold text-white shadow-sm disabled:opacity-60"
                disabled={isSubmitting}
              >
                {isSubmitting
                  ? t('workbench.logging_in', '登录中...')
                  : t('workbench.login_action', '登录')}
              </button>
            </form>
          )}
          {showPasswordLogin && showOidcLogin && (
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-text-muted">
                {t('workbench.login_or_continue', '或继续使用')}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          {showOidcLogin && (
            <button
              type="button"
              data-testid="oidc-login-button"
              className="h-11 w-full rounded-lg border border-border bg-background text-sm font-semibold text-text-primary hover:bg-muted"
              onClick={handleOidcLogin}
            >
              {config.oidcLoginText || t('workbench.oidc_login', '使用 OpenID Connect 登录')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
