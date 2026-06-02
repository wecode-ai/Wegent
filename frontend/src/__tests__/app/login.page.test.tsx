// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { useRouter, useSearchParams } from 'next/navigation'

import LoginPage from '@/app/login/page'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  useSearchParams: jest.fn(),
}))

jest.mock('@/features/login/components/LogoHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="logo-header" />,
  LogoSubTitle: () => <div data-testid="logo-subtitle" />,
}))

jest.mock('@/features/login/components/LoginForm', () => ({
  __esModule: true,
  default: () => <div data-testid="login-form" />,
}))

jest.mock('@/features/common/UserContext', () => ({
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('LoginPage', () => {
  const originalAuthMode = process.env.NEXT_PUBLIC_AUTH_MODE

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NEXT_PUBLIC_AUTH_MODE = 'dingtalk'
    ;(useRouter as jest.Mock).mockReturnValue({ replace: mockReplace })
  })

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_MODE = originalAuthMode
  })

  it('should redirect to DingTalk auth when DingTalk mode is enabled without override', () => {
    ;(useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams())

    render(<LoginPage />)

    expect(mockReplace).toHaveBeenCalledWith('/auth/dingtalk')
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
  })

  it('should show local login page when password_login parameter is present', () => {
    ;(useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams('password_login'))

    render(<LoginPage />)

    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.getByTestId('login-form')).toBeInTheDocument()
  })
})
