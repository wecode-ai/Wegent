import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, QrCode, RefreshCw } from 'lucide-react'
import type { WeiboQrcodeChallenge } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

const QRCODE_POLL_INTERVAL_MS = 2000

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
  const {
    login,
    user,
    isLoading: authLoading,
    createWeiboQrcodeChallenge,
    loginWithWeiboQrcode,
  } = useAuth()
  const config = useMemo(() => getRuntimeConfig(), [])
  const isMobile = useIsMobile()
  const [formData, setFormData] = useState({
    user_name: 'admin',
    password: 'Wegent2025!',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qrcodeChallenge, setQrcodeChallenge] =
    useState<WeiboQrcodeChallenge | null>(null)
  const [qrcodeStatus, setQrcodeStatus] = useState<
    'idle' | 'loading' | 'waiting' | 'expired' | 'error'
  >('idle')
  const [qrcodeNonce, setQrcodeNonce] = useState(0)
  const redirectTarget = getRedirectTarget()
  const showPasswordLogin = config.loginMode === 'password' || config.loginMode === 'all'
  const showOidcLogin = config.loginMode === 'oidc' || config.loginMode === 'all'
  const showWeiboQrcodeLogin = isMobile

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

  useEffect(() => {
    if (!showWeiboQrcodeLogin) return

    let isCancelled = false

    async function loadQrcode() {
      setQrcodeStatus('loading')
      setQrcodeChallenge(null)
      try {
        const challenge = await createWeiboQrcodeChallenge()
        if (isCancelled) return
        setQrcodeChallenge(challenge)
        setQrcodeStatus('waiting')
      } catch {
        if (isCancelled) return
        setQrcodeStatus('error')
      }
    }

    void Promise.resolve().then(() => loadQrcode())

    return () => {
      isCancelled = true
    }
  }, [createWeiboQrcodeChallenge, qrcodeNonce, showWeiboQrcodeLogin])

  useEffect(() => {
    if (!showWeiboQrcodeLogin || !qrcodeChallenge || qrcodeStatus !== 'waiting') {
      return
    }

    let isCancelled = false
    const expiresAt = Date.now() + qrcodeChallenge.expires_in * 1000

    const poll = async () => {
      if (Date.now() >= expiresAt) {
        if (!isCancelled) {
          setQrcodeStatus('expired')
        }
        return
      }

      try {
        const loggedInUser = await loginWithWeiboQrcode(
          qrcodeChallenge.sid,
          qrcodeChallenge.qr_data,
        )
        if (!loggedInUser || isCancelled) return
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
        navigateTo(redirectTarget)
      } catch {
        if (!isCancelled) {
          setQrcodeStatus('error')
        }
      }
    }

    const interval = window.setInterval(() => {
      void poll()
    }, QRCODE_POLL_INTERVAL_MS)

    void poll()

    return () => {
      isCancelled = true
      window.clearInterval(interval)
    }
  }, [
    loginWithWeiboQrcode,
    qrcodeChallenge,
    qrcodeStatus,
    redirectTarget,
    showWeiboQrcodeLogin,
  ])

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

  function refreshQrcode() {
    setQrcodeNonce(current => current + 1)
  }

  if (config.loginMode === 'oidc') {
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-6 py-12">
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
          {showWeiboQrcodeLogin && (
            <div
              data-testid="mobile-weibo-qrcode-login"
              className="mb-6 rounded-xl border border-border bg-base p-5 text-center"
            >
              <div className="mb-4 flex items-center justify-center gap-2 text-text-primary">
                <QrCode className="h-5 w-5" />
                <h2 className="text-lg font-semibold">
                  {t('workbench.mobile_qrcode_login_title')}
                </h2>
              </div>
              <p className="mb-4 text-sm text-text-muted">
                {t('workbench.mobile_qrcode_login_description')}
              </p>
              <div className="mx-auto flex aspect-square w-full max-w-[220px] items-center justify-center rounded-lg border border-border bg-white p-3">
                {qrcodeChallenge && qrcodeStatus === 'waiting' ? (
                  <img
                    data-testid="mobile-weibo-qrcode-image"
                    src={qrcodeChallenge.qr_code_image}
                    alt={t('workbench.mobile_qrcode_alt')}
                    className="h-full w-full"
                  />
                ) : (
                  <div className="px-3 text-sm text-text-muted">
                    {qrcodeStatus === 'loading' && t('workbench.mobile_qrcode_loading')}
                    {qrcodeStatus === 'expired' && t('workbench.mobile_qrcode_expired')}
                    {qrcodeStatus === 'error' && t('workbench.mobile_qrcode_failed')}
                  </div>
                )}
              </div>
              <div className="mt-4 text-sm text-text-secondary">
                {qrcodeStatus === 'waiting' && t('workbench.mobile_qrcode_waiting')}
              </div>
              {(qrcodeStatus === 'expired' || qrcodeStatus === 'error') && (
                <button
                  type="button"
                  data-testid="refresh-mobile-weibo-qrcode-button"
                  className="mt-4 inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-text-primary"
                  onClick={refreshQrcode}
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('workbench.mobile_qrcode_refresh')}
                </button>
              )}
            </div>
          )}
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
                  className="mt-2 h-11 w-full rounded-lg border border-border bg-base px-3 text-sm text-text-primary outline-none focus:border-text-secondary"
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
                    className="h-11 w-full rounded-lg border border-border bg-base px-3 pr-11 text-sm text-text-primary outline-none focus:border-text-secondary"
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
                className="h-11 w-full rounded-lg bg-text-primary text-sm font-semibold text-base shadow-sm disabled:opacity-60"
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
              className="h-11 w-full rounded-lg border border-border bg-base text-sm font-semibold text-text-primary hover:bg-muted"
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
