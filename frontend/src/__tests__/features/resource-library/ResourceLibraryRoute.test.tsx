// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import Page from '@/app/(tasks)/resource-library/page'

const mockRefreshTeams = jest.fn()

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getDiscoveryConfig: jest.fn().mockResolvedValue({
      assistant_team_ref: { name: 'resource-discovery-assistant', namespace: 'default' },
      knowledge_base_ref: null,
    }),
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

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [],
    isTeamsLoading: false,
    refreshTeams: mockRefreshTeams,
  }),
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: () => <div data-testid="discover-assistant-chat-area" />,
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
        'discover.assistant.action': '发现助手',
        'discover.assistant.agent_badge': 'Agent',
        'discover.assistant.callout_description':
          '告诉发现助手你想完成的任务，它会帮你缩小范围并推荐资源。',
        'discover.assistant.callout_title': '不确定该找什么？',
        'discover.assistant.description':
          '这是一个实际智能体，会通过聊天帮你梳理任务并选择合适资源。',
        'discover.assistant.empty_description':
          '输入你要完成的任务、使用场景或现有问题，它会以智能体对话的方式帮你判断该接受哪个资源。',
        'discover.assistant.empty_title': '让发现助手帮你找资源',
        'discover.assistant.loading': '正在加载发现助手',
        'discover.assistant.prompts.code_review': '找代码评审助手',
        'discover.assistant.prompts.doc_summary': '找文档总结技能',
        'discover.assistant.prompts.weekly_report': '帮我找能写周报的助手',
        'discover.assistant.title': '发现助手',
        'discover.assistant.unavailable_description':
          '系统还没有可用的发现助手智能体，请先初始化公开资源后再使用。',
        'discover.assistant.unavailable_title': '发现助手未初始化',
        'discover.card.no_tags': '暂无标签',
        'discover.description': '浏览团队发布的智能体和技能说明，接受分享后即可进入你的资源列表。',
        'discover.title': '资源市场',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'fields.tags': '标签',
        'search.placeholder': '搜索资源',
        'actions.close': '关闭',
        'actions.details': '详情',
        'actions.install': '接受分享',
        'actions.installed': '已接受',
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
