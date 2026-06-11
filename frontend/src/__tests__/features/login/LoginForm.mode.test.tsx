// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { useSearchParams } from 'next/navigation'

import LoginForm from '@/features/login/components/LoginForm'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: jest.fn(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: null,
    isLoading: false,
    login: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common:login.username': 'Username',
        'common:login.password': 'Password',
        'common:login.enter_username': 'Enter username',
        'common:login.enter_password': 'Enter password',
        'common:login.oidc_login': 'Login with OpenID Connect',
        'common:user.login': 'Login',
        'common:login.test_account': 'Test account',
        'common:login.or_continue_with': 'Or continue with',
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/components/LanguageSwitcher', () => ({
  __esModule: true,
  default: () => <button type="button">Language</button>,
}))

jest.mock('@/features/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt: string }) => <span aria-label={alt} role="img" />,
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: jest.fn(),
}))

describe('LoginForm display mode', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    ;(useSearchParams as jest.Mock).mockImplementation(() => mockSearchParams)
    ;(getRuntimeConfigSync as jest.Mock).mockReturnValue({
      loginMode: 'oidc',
      oidcLoginText: 'SSO Login',
    })
  })

  it('should respect runtime login mode when password_login parameter is absent', () => {
    render(<LoginForm />)

    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SSO Login/i })).toBeInTheDocument()
  })

  it('should show password login only when password_login parameter is present', () => {
    mockSearchParams = new URLSearchParams('password_login')

    render(<LoginForm />)

    expect(getRuntimeConfigSync).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /SSO Login/i })).not.toBeInTheDocument()
  })

  it('should not force password login when Aidesk auth parameters are present', () => {
    mockSearchParams = new URLSearchParams(
      'source=aidesk&username=testuser&timestamp=1730000000&sign=abcdef&password_login'
    )

    render(<LoginForm />)

    expect(getRuntimeConfigSync).toHaveBeenCalled()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SSO Login/i })).toBeInTheDocument()
  })
})
