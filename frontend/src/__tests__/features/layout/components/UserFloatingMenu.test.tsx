// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'

import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu'

const push = jest.fn()
const logout = jest.fn()
const changeLanguage = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      user_name: 'shiqiong',
      role: 'user',
    },
    logout,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  languageNames: {
    'zh-CN': '简体中文',
    en: 'English',
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    changeLanguage,
    getCurrentLanguage: () => 'zh-CN',
    getSupportedLanguages: () => ['zh-CN', 'en'],
  }),
}))

jest.mock('@/features/layout/DocsButton', () => ({
  DocsButton: ({ className = '', onClick }: { className?: string; onClick?: () => void }) => (
    <button type="button" className={className} onClick={onClick}>
      docs
    </button>
  ),
}))

jest.mock('@/features/layout/FeedbackButton', () => ({
  FeedbackButton: ({ className = '', onClick }: { className?: string; onClick?: () => void }) => (
    <button type="button" className={className} onClick={onClick}>
      feedback
    </button>
  ),
}))

jest.mock('@/features/theme/ThemeToggle', () => ({
  ThemeToggle: ({ className = '', onToggle }: { className?: string; onToggle?: () => void }) => (
    <button type="button" className={className} onClick={onToggle}>
      theme
    </button>
  ),
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({
    appVersion: '1.0.0',
  }),
}))

describe('UserFloatingMenu', () => {
  beforeEach(() => {
    push.mockReset()
    logout.mockReset()
    changeLanguage.mockReset()
  })

  it('keeps the expanded floating menu above the sidebar navigation layer', () => {
    render(<UserFloatingMenu />)

    const toggleButton = screen.getByRole('button', { name: /shiqiong/i })
    fireEvent.click(toggleButton)

    const root = toggleButton.closest('div.relative')
    const menu = screen.getByRole('menu', { name: 'User menu' })

    expect(root).toHaveClass('z-30')
    expect(menu).toHaveClass('z-40')
    expect(menu).toHaveClass('pointer-events-auto')
  })

  it('keeps the account toggle unambiguous when Issue cards show the same username', () => {
    const openIssue = jest.fn()
    render(
      <>
        <button type="button" onClick={openIssue}>
          Issue awaiting shiqiong
        </button>
        <UserFloatingMenu />
      </>
    )
    expect(screen.getAllByRole('button', { name: /shiqiong/i })).toHaveLength(2)
    const toggle = screen.getByTestId('user-floating-menu-toggle')
    expect(within(toggle).getByText('shiqiong', { exact: true })).toBeVisible()
    fireEvent.click(toggle)
    expect(openIssue).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'User menu' })).toBeVisible()
  })
})
