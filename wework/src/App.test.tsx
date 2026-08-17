import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import App from './App'

const appMocks = vi.hoisted(() => ({
  authLoading: false,
  codexHomeReady: true,
  localRuntimeRender: vi.fn(),
}))

vi.mock('@/features/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: null,
    isLoading: appMocks.authLoading,
    adminPasswordSetupRequired: false,
    adminUsername: 'admin',
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    loginWithOidcToken: vi.fn(),
    setupAdminPassword: vi.fn(),
  }),
}))

vi.mock('@/features/local-runtime/CodexHomeInitializer', () => ({
  CodexHomeInitializer: ({ children }: { children: React.ReactNode }) =>
    appMocks.codexHomeReady ? <>{children}</> : <div data-testid="codex-home-gate" />,
}))

vi.mock('@/features/local-runtime/LocalRuntimeInitializer', () => ({
  LocalRuntimeInitializer: ({ children }: { children: React.ReactNode }) => {
    appMocks.localRuntimeRender()
    return <>{children}</>
  },
}))

describe('App auth routing', () => {
  afterEach(() => {
    cleanup()
    appMocks.authLoading = false
    appMocks.codexHomeReady = true
    appMocks.localRuntimeRender.mockClear()
  })

  test('renders login page on /login', async () => {
    window.history.pushState({}, '', '/login')

    render(<App />)

    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
  })

  test('waits for Codex home initialization before starting the local runtime', () => {
    window.history.pushState({}, '', '/')
    appMocks.authLoading = true
    appMocks.codexHomeReady = false

    render(<App />)

    expect(screen.getByTestId('codex-home-gate')).toBeInTheDocument()
    expect(appMocks.localRuntimeRender).not.toHaveBeenCalled()
  })
})
