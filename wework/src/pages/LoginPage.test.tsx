import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from './LoginPage'

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    window.history.pushState({}, '', '/login')
  })

  test('logs in with password credentials and redirects to the workbench', async () => {
    const authApi = {
      getCurrentUser: vi.fn(),
      login: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>,
    )

    await userEvent.clear(screen.getByTestId('login-username-input'))
    await userEvent.type(screen.getByTestId('login-username-input'), 'alice')
    await userEvent.clear(screen.getByTestId('login-password-input'))
    await userEvent.type(screen.getByTestId('login-password-input'), 'secret')
    await userEvent.click(screen.getByTestId('login-submit-button'))

    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith({ user_name: 'alice', password: 'secret' }),
    )
    expect(window.location.pathname).toBe('/')
  })

  test('uses the OIDC outlined button standard for the password login action', () => {
    const authApi = {
      getCurrentUser: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>,
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

    expect(screen.getByTestId('login-submit-button')).toHaveClass(...standardClasses)
    expect(screen.getByTestId('oidc-login-button')).toHaveClass(...standardClasses)
  })
})
