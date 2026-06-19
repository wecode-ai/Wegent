import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { setToken } from '@/api/auth'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

function createJwt(expSeconds: number) {
  return `header.${btoa(JSON.stringify({ exp: expSeconds }))}.signature`
}

function Probe() {
  const { user, isLoading } = useAuth()
  return <div data-testid="auth-probe">{isLoading ? 'loading' : (user?.user_name ?? 'none')}</div>
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    window.history.pushState({}, '', '/')
  })

  test('loads current user when token is valid', async () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))
    const authApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      getAdminPasswordSetupStatus: vi.fn().mockResolvedValue({ required: false }),
      setupAdminPassword: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth-probe')).toHaveTextContent('alice'))
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
})
