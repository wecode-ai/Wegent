import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/auth/redirect'
import { OidcCallbackPage } from './OidcCallbackPage'

describe('OidcCallbackPage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('stores callback access token and redirects to stored target', async () => {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '/projects?x=1')
    window.history.pushState({}, '', '/login/oidc?access_token=token-1&login_success=true')
    const authApi = {
      getCurrentUser: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn().mockResolvedValue(undefined),
    }

    render(
      <AuthProvider authApi={authApi}>
        <OidcCallbackPage />
      </AuthProvider>,
    )

    await waitFor(() => expect(authApi.loginWithOidcToken).toHaveBeenCalledWith('token-1'))
    expect(window.location.pathname).toBe('/projects')
    expect(window.location.search).toBe('?x=1')
  })
})
