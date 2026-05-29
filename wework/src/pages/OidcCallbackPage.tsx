import { useEffect } from 'react'
import { getRuntimeConfig } from '@/config/runtime'
import {
  POST_LOGIN_REDIRECT_KEY,
  sanitizeRedirectPath,
} from '@/features/auth/redirect'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export function OidcCallbackPage() {
  const { t } = useTranslation('common')
  const { loginWithOidcToken } = useAuth()

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const accessToken = searchParams.get('access_token')
    const loginSuccess = searchParams.get('login_success')

    if (accessToken && loginSuccess === 'true') {
      loginWithOidcToken(accessToken)
        .then(() => {
          const queryRedirect = sanitizeRedirectPath(searchParams.get('redirect'), [
            '/login',
            '/login/oidc',
          ])
          const storedRedirect = sanitizeRedirectPath(
            sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY),
            ['/login', '/login/oidc'],
          )
          sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          navigateTo(queryRedirect || storedRedirect || '/')
        })
        .catch(() => {
          sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          navigateTo('/login')
        })
      return
    }

    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error || !code || !state) {
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      navigateTo('/login')
      return
    }

    const { apiBaseUrl } = getRuntimeConfig()
    window.location.href = `${apiBaseUrl}/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
  }, [loginWithOidcToken])

  return (
    <div className="flex min-h-screen items-center justify-center bg-base">
      <div className="rounded-2xl border border-border bg-surface px-8 py-8 text-sm font-medium text-text-secondary shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
        {t('workbench.oidc_processing', '正在处理 OpenID Connect 登录...')}
      </div>
    </div>
  )
}
