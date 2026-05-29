// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import Page from '@/app/(tasks)/settings/page'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: () => new URLSearchParams('tab=models'),
}))

jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
  }: {
    children: React.ReactNode
    href: string | { toString: () => string }
  }) => <a href={typeof href === 'string' ? href : href.toString()}>{children}</a>
  MockLink.displayName = 'MockLink'
  return MockLink
})

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: ({ title }: { title?: string }) => <nav>{title}</nav>,
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  CollapsedSidebarButtons: () => <div />,
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  TaskSidebar: () => <div />,
}))

jest.mock('@/features/layout/GithubStarButton', () => ({
  GithubStarButton: () => <button type="button">GitHub</button>,
}))

jest.mock('@/features/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}))

jest.mock('@/features/settings/components/IntegrationsPage', () => ({
  __esModule: true,
  default: () => <div>Integrations</div>,
}))

jest.mock('@/features/settings/components/NotificationSettings', () => ({
  __esModule: true,
  default: () => <div>General Settings</div>,
}))

jest.mock('@/features/settings/components/groups/GroupManager', () => ({
  GroupManager: () => <div>Group Manager</div>,
}))

jest.mock('@/features/settings/components/ApiKeyList', () => ({
  __esModule: true,
  default: () => <div>API Keys</div>,
}))

jest.mock('@/features/pet/components/PetSettings', () => ({
  PetSettings: () => <div>Pet Settings</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common:settings.title': '设置',
        'sections.general': '通用',
        'navigation.integrations': '集成',
        'navigation.apiKeys': 'API 密钥',
        'navigation.groupManager': '组管理',
        'pet:title': '我的宠物',
        'resourceGuide.title': '资源管理已移到资源库',
        'resourceGuide.description': '智能体、模型、执行器、技能和检索器现在在资源库管理。',
        'resourceGuide.action': '前往资源库',
      }

      return translations[key] ?? key
    },
  }),
}))

describe('Settings resource guide', () => {
  it('guides users from the old settings page to resource library management', async () => {
    render(<Page />)

    expect(await screen.findByText('资源管理已移到资源库')).toBeInTheDocument()
    expect(
      screen.getByText('智能体、模型、执行器、技能和检索器现在在资源库管理。')
    ).toBeInTheDocument()

    const resourceLibraryLinks = screen.getAllByRole('link', { name: '前往资源库' })
    expect(resourceLibraryLinks).toHaveLength(1)
    expect(resourceLibraryLinks[0]).toHaveAttribute('href', '/resource-library')
  })
})
