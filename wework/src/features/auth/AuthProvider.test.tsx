import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { setToken } from '@/api/auth'
import { ApiError } from '@/api/http'
import { LOCAL_USER } from '@/api/local/localSession'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

function createJwt(expSeconds: number) {
  return `header.${btoa(JSON.stringify({ exp: expSeconds }))}.signature`
}

function Probe() {
  const { user, isLoading, adminPasswordSetupRequired, adminUsername } = useAuth()
  return (
    <div data-testid="auth-probe">
      {isLoading
        ? 'loading'
        : `${user?.user_name ?? 'none'}:${adminPasswordSetupRequired ? adminUsername : 'ready'}`}
    </div>
  )
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    delete window.__WEWORK_RUNTIME_CONFIG__
    window.history.pushState({}, '', '/')
  })

  test('loads current user when token is valid', async () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))
    const authApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      getCurrentUserWithoutAuthRedirect: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      setupAdminPassword: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth-probe')).toHaveTextContent('alice'))
  })

  test('redirects protected routes to login when admin password setup is required', async () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))
    window.history.pushState({}, '', '/')
    const authApi = {
      getCurrentUser: vi.fn().mockRejectedValue(
        new ApiError('ADMIN_PASSWORD_SETUP_REQUIRED', 400, 'ADMIN_PASSWORD_SETUP_REQUIRED', {
          error_code: 'ADMIN_PASSWORD_SETUP_REQUIRED',
          admin_username: 'admin',
        })
      ),
      getCurrentUserWithoutAuthRedirect: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      setupAdminPassword: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth-probe')).toHaveTextContent('none:admin'))
    expect(window.location.pathname).toBe('/login')
    expect(sessionStorage.getItem('postLoginRedirectPath')).toBe('/')
  })

  test('redirects protected routes to login when token is missing', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth-probe')).toHaveTextContent('none'))
    expect(window.location.pathname).toBe('/login')
  })

  test('creates local user without redirect or backend calls in local-first mode', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      runtimeMode: 'local-first',
    }
    const authApi = {
      getCurrentUser: vi.fn(),
      getCurrentUserWithoutAuthRedirect: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      setupAdminPassword: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('auth-probe')).toHaveTextContent(`${LOCAL_USER.user_name}:ready`)
    )
    expect(window.location.pathname).toBe('/')
    expect(authApi.getCurrentUser).not.toHaveBeenCalled()
    expect(authApi.getCurrentUserWithoutAuthRedirect).not.toHaveBeenCalled()
  })
})
