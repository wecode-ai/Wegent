import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from './LoginPage'

describe('LoginPage', () => {
  function createAuthApi(overrides: Record<string, unknown> = {}) {
    return {
      getCurrentUser: vi.fn().mockRejectedValue(new ApiError('Unauthorized', 401)),
      getCurrentUserWithoutAuthRedirect: vi
        .fn()
        .mockRejectedValue(new ApiError('Unauthorized', 401)),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      setupAdminPassword: vi.fn(),
      ...overrides,
    }
  }

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    window.__WEWORK_RUNTIME_CONFIG__ = {
      runtimeMode: 'backend',
    }
    window.history.pushState({}, '', '/login')
  })

  test('logs in with password credentials and redirects to the workbench', async () => {
    const authApi = createAuthApi({
      login: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
    })

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>
    )

    await screen.findByTestId('login-username-input')
    await userEvent.clear(screen.getByTestId('login-username-input'))
    await userEvent.type(screen.getByTestId('login-username-input'), 'alice')
    await userEvent.clear(screen.getByTestId('login-password-input'))
    await userEvent.type(screen.getByTestId('login-password-input'), 'secret')
    await userEvent.click(screen.getByTestId('login-submit-button'))

    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith({ user_name: 'alice', password: 'secret' })
    )
    expect(window.location.pathname).toBe('/')
  })

  test('does not prefill the removed default admin password', async () => {
    const authApi = createAuthApi()

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>
    )

    expect(await screen.findByTestId('login-username-input')).toHaveValue('')
    expect(screen.getByTestId('login-password-input')).toHaveValue('')
    expect(screen.queryByDisplayValue('Wegent2025!')).not.toBeInTheDocument()
  })

  test('sets the first-run admin password before showing normal login', async () => {
    const authApi = createAuthApi({
      getCurrentUserWithoutAuthRedirect: vi.fn().mockRejectedValue(
        new ApiError('ADMIN_PASSWORD_SETUP_REQUIRED', 400, 'ADMIN_PASSWORD_SETUP_REQUIRED', {
          error_code: 'ADMIN_PASSWORD_SETUP_REQUIRED',
          admin_username: 'root-admin',
        })
      ),
      setupAdminPassword: vi.fn().mockResolvedValue({ id: 1, user_name: 'admin', email: null }),
    })

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>
    )

    expect(await screen.findByTestId('admin-password-setup-form')).toBeInTheDocument()
    expect(authApi.getCurrentUserWithoutAuthRedirect).toHaveBeenCalled()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-username-value')).toHaveTextContent('root-admin')

    await userEvent.type(screen.getByTestId('admin-password-input'), 'new-secure-password')
    await userEvent.type(screen.getByTestId('admin-password-confirm-input'), 'new-secure-password')
    await userEvent.click(screen.getByTestId('admin-password-submit-button'))

    await waitFor(() => {
      expect(authApi.setupAdminPassword).toHaveBeenCalledWith('new-secure-password')
    })
    expect(authApi.login).not.toHaveBeenCalled()
  })

  test('continues to normal login when anonymous setup handshake is unavailable', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const authApi = createAuthApi({
      getCurrentUserWithoutAuthRedirect: vi
        .fn()
        .mockRejectedValue(new Error('network unavailable')),
    })

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>
    )

    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-password-setup-form')).not.toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })

  test('uses the OIDC outlined button standard for the password login action', async () => {
    const authApi = createAuthApi()

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>
    )

    const standardClasses = [
      'h-11',
      'w-full',
      'rounded-lg',
      'border',
      'border-border',
      'bg-background',
      'text-sm',
      'font-semibold',
      'text-text-primary',
      'hover:bg-muted',
    ]

    expect(await screen.findByTestId('login-submit-button')).toHaveClass(...standardClasses)
    expect(screen.getByTestId('oidc-login-button')).toHaveClass(...standardClasses)
  })
})
