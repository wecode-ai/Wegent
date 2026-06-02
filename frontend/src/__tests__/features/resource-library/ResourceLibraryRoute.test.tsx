// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import Page from '@/app/(tasks)/resource-library/page'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listListings: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listMyInstalls: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listMyPublished: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getListing: jest.fn(),
    installListing: jest.fn(),
    createListing: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: jest.fn(),
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: ({
    title,
    onMobileSidebarToggle,
  }: {
    title?: string
    onMobileSidebarToggle?: () => void
  }) => (
    <nav data-testid="resource-library-top-navigation">
      <span>{title}</span>
      <button type="button" onClick={onMobileSidebarToggle}>
        open sidebar
      </button>
    </nav>
  ),
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  CollapsedSidebarButtons: () => <div data-testid="resource-library-collapsed-sidebar" />,
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => (
    <aside data-testid="resource-library-resizable-sidebar">{children}</aside>
  ),
  TaskSidebar: ({ pageType }: { pageType?: string }) => (
    <div data-testid="resource-library-task-sidebar" data-page-type={pageType} />
  ),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectTask: jest.fn(),
  }),
}))

jest.mock('@/features/resource-library/components/MyResources', () => ({
  MyResources: () => <div data-testid="my-resource-management">资源管理</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        title: '资源库',
        'tabs.discover': '发现',
        'tabs.mine': '我的',
        'tabs.installed': '已接受',
        'tabs.published': '我发布的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'fields.tags': '标签',
        'search.placeholder': '搜索资源',
        'actions.search': '搜索',
        'actions.publish': '发布资源',
        'actions.retry': '重试',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
      }

      return translations[key] ?? key
    },
  }),
}))

describe('ResourceLibrary route page', () => {
  it('renders with the task sidebar active and discover selected by default', async () => {
    render(<Page />)

    expect(screen.getByTestId('resource-library-task-sidebar')).toHaveAttribute(
      'data-page-type',
      'resource-library'
    )
    expect(screen.getByTestId('resource-library-top-navigation')).toHaveTextContent('资源库')
    expect(screen.queryByRole('heading', { name: '资源库' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toBeInTheDocument()
    expect(screen.queryByTestId('my-resource-management')).not.toBeInTheDocument()
    expect(await screen.findByText('暂无资源')).toBeInTheDocument()
  })
})
