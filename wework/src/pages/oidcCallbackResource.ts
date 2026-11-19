import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { getRuntimeConfig } from '@/config/runtime'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/auth/redirect'
import type { AuthContextValue } from '@/features/auth/useAuth'
import { navigateTo } from '@/lib/navigation'

/** A callback URL owns one login/exchange result, without exposing its credentials in the snapshot. */
export function createOidcCallbackResource(
  search: string,
  loginWithOidcToken: AuthContextValue['loginWithOidcToken']
) {
  const parameters = new URLSearchParams(search)
  const reject = () => {
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
    navigateTo('/login')
  }
  return createAsyncResource(
    'oidc-callback',
    async () => {
      const accessToken = parameters.get('access_token')
      if (accessToken && parameters.get('login_success') === 'true') {
        await loginWithOidcToken(accessToken)
        return 'authenticated' as const
      }
      if (parameters.get('error') || !parameters.get('code') || !parameters.get('state'))
        return 'rejected' as const
      return 'exchange' as const
    },
    {
      success(result) {
        if (result === 'rejected') {
          reject()
        } else if (result === 'exchange') {
          const { apiBaseUrl } = getRuntimeConfig()
          window.location.href = `${apiBaseUrl}/auth/oidc/callback?code=${encodeURIComponent(parameters.get('code')!)}&state=${encodeURIComponent(parameters.get('state')!)}`
        } else {
          const disallow = ['/login', '/login/oidc']
          const queryRedirect = sanitizeRedirectPath(parameters.get('redirect'), disallow)
          const storedRedirect = sanitizeRedirectPath(
            sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY),
            disallow
          )
          sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          navigateTo(queryRedirect || storedRedirect || '/')
        }
      },
      failure: reject,
    }
  )
}
