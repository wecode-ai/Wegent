import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import App from './App'

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    adminPasswordSetupRequired: false,
    adminUsername: 'admin',
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    loginWithOidcToken: vi.fn(),
    setupAdminPassword: vi.fn(),
  }),
}))

describe('App auth routing', () => {
  afterEach(() => {
    cleanup()
  })

  test('renders login page on /login', async () => {
    window.history.pushState({}, '', '/login')

    render(<App />)

    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
  })
})
