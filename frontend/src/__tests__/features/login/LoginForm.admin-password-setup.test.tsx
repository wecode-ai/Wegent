// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import LoginForm from '@/features/login/components/LoginForm'
import { userApis } from '@/apis/user'
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

jest.mock('@/apis/user', () => ({
  userApis: {
    getAdminPasswordSetupStatus: jest.fn(),
  },
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

  it('shows first-run admin password setup instead of default credentials', async () => {
    ;(userApis.getAdminPasswordSetupStatus as jest.Mock).mockResolvedValue({
      required: true,
      admin_username: 'root-admin',
    })

    render(<LoginForm />)

    expect(await screen.findByTestId('admin-password-setup-form')).toBeInTheDocument()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-username-value')).toHaveTextContent('root-admin')
    expect(screen.getByTestId('admin-password-visibility-button')).toHaveClass(
      'h-11',
      'min-w-[44px]'
    )
    expect(screen.getByTestId('admin-password-confirm-visibility-button')).toHaveClass(
      'h-11',
      'min-w-[44px]'
    )
    expect(screen.queryByDisplayValue('Wegent2025!')).not.toBeInTheDocument()

    await userEvent.type(screen.getByTestId('admin-password-input'), 'new-secure-password')
    await userEvent.type(screen.getByTestId('admin-password-confirm-input'), 'new-secure-password')
    await userEvent.click(screen.getByTestId('admin-password-submit-button'))

    await waitFor(() => {
      expect(setupAdminPassword).toHaveBeenCalledWith('new-secure-password')
    })
    expect(login).not.toHaveBeenCalled()
  })

  it('leaves normal login credentials empty when admin password setup is not required', async () => {
    ;(userApis.getAdminPasswordSetupStatus as jest.Mock).mockResolvedValue({
      required: false,
      admin_username: 'admin',
    })

    render(<LoginForm />)

    const usernameInput = await screen.findByTestId('login-username-input')
    const passwordInput = screen.getByTestId('login-password-input')

    expect(usernameInput).toHaveValue('')
    expect(passwordInput).toHaveValue('')
    expect(screen.queryByDisplayValue('Wegent2025!')).not.toBeInTheDocument()
  })

  it('blocks password and OIDC login when setup status cannot be confirmed', async () => {
    mockRuntimeConfig.loginMode = 'all'
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(userApis.getAdminPasswordSetupStatus as jest.Mock).mockRejectedValue(
      new Error('network unavailable')
    )

    render(<LoginForm />)

    expect(await screen.findByTestId('login-setup-status-error')).toBeInTheDocument()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-password-setup-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('oidc-login-button')).not.toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })
})
