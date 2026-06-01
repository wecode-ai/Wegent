import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from './LoginPage'

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubEnv('VITE_LOGIN_MODE', 'all')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    window.history.pushState({}, '', '/login')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('logs in with password credentials and redirects to the workbench', async () => {
    const authApi = {
      getCurrentUser: vi.fn(),
      login: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      createWeiboQrcodeChallenge: vi.fn(),
      loginWithWeiboQrcode: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>,
    )

    expect(screen.queryByTestId('mobile-weibo-qrcode-login')).not.toBeInTheDocument()
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

  test('shows Weibo QR code login only on mobile', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const authApi = {
      getCurrentUser: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
      createWeiboQrcodeChallenge: vi.fn().mockResolvedValue({
        sid: 'sid-1',
        qr_data: 'https://koudai.sina.com/qr',
        qr_code_image: 'data:image/png;base64,abc',
        expires_in: 60,
      }),
      loginWithWeiboQrcode: vi.fn().mockResolvedValue(null),
    }

    render(
      <AuthProvider authApi={authApi}>
        <LoginPage />
      </AuthProvider>,
    )

    expect(await screen.findByTestId('mobile-weibo-qrcode-login')).toBeInTheDocument()
    expect(await screen.findByTestId('mobile-weibo-qrcode-image')).toHaveAttribute(
      'src',
      'data:image/png;base64,abc',
    )
  })
})
