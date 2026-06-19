// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ApiError } from '@/apis/client'
import LoginForm from '@/features/login/components/LoginForm'
import { useUser } from '@/features/common/UserContext'

const mockReplace = jest.fn()
const mockSearchParams = {
  get: jest.fn(() => null),
}
const mockRuntimeConfig = {
  loginMode: 'password',
  oidcLoginText: '',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => mockRuntimeConfig,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}))

jest.mock('@/components/LanguageSwitcher', () => ({
  __esModule: true,
  default: () => <button type="button">language</button>,
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: jest.fn(),
}))

describe('LoginForm admin password setup', () => {
  const login = jest.fn()
  const setupAdminPassword = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    mockRuntimeConfig.loginMode = 'password'
    mockRuntimeConfig.oidcLoginText = ''
    sessionStorage.clear()
    ;(useUser as jest.Mock).mockReturnValue({
      user: null,
      isLoading: false,
      login,
      setupAdminPassword,
    })
  })

  it('shows password login immediately without checking setup status first', () => {
    render(<LoginForm />)

    expect(screen.queryByTestId('login-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('login-form')).toBeInTheDocument()
    expect(screen.getByTestId('login-username-input')).toHaveValue('')
    expect(screen.getByTestId('login-password-input')).toHaveValue('')
  })

  it('shows first-run admin password setup when login returns setup-required error code', async () => {
    login.mockRejectedValue(
      new ApiError('ADMIN_PASSWORD_SETUP_REQUIRED', 400, 'ADMIN_PASSWORD_SETUP_REQUIRED')
    )

    render(<LoginForm />)

    await userEvent.type(screen.getByTestId('login-username-input'), 'admin')
    await userEvent.type(screen.getByTestId('login-password-input'), 'unused-password')
    await userEvent.click(screen.getByTestId('login-submit-button'))

    expect(await screen.findByTestId('admin-password-setup-form')).toBeInTheDocument()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-username-value')).toHaveTextContent('admin')
    expect(screen.getByTestId('admin-password-visibility-button')).toHaveClass(
      'h-11',
      'min-w-[44px]'
    )
    expect(screen.getByTestId('admin-password-confirm-visibility-button')).toHaveClass(
      'h-11',
      'min-w-[44px]'
    )
    expect(screen.queryByDisplayValue('Wegent2025!')).not.toBeInTheDocument()

    login.mockReset()
    await userEvent.type(screen.getByTestId('admin-password-input'), 'new-secure-password')
    await userEvent.type(screen.getByTestId('admin-password-confirm-input'), 'new-secure-password')
    await userEvent.click(screen.getByTestId('admin-password-submit-button'))

    await waitFor(() => {
      expect(setupAdminPassword).toHaveBeenCalledWith('new-secure-password')
    })
    expect(login).not.toHaveBeenCalled()
  })

  it('leaves normal login credentials empty when admin password setup is not triggered', () => {
    render(<LoginForm />)

    const usernameInput = screen.getByTestId('login-username-input')
    const passwordInput = screen.getByTestId('login-password-input')

    expect(usernameInput).toHaveValue('')
    expect(passwordInput).toHaveValue('')
    expect(screen.queryByDisplayValue('Wegent2025!')).not.toBeInTheDocument()
  })

  it('shows password and OIDC login without blocking on setup status confirmation', () => {
    mockRuntimeConfig.loginMode = 'all'

    render(<LoginForm />)

    expect(screen.queryByTestId('login-setup-status-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('login-form')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-password-setup-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('oidc-login-button')).toBeInTheDocument()
  })
})
