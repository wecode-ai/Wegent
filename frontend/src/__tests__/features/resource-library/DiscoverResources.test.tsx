// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { DiscoverResources } from '@/features/resource-library/components/DiscoverResources'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

const mockToast = jest.fn()
const mockRefreshTeams = jest.fn()
const mockDiscoverAssistantTeam = {
  id: 100,
  name: 'resource-discovery-assistant',
  displayName: '发现助手',
  namespace: 'default',
  description: 'Helps users discover resources',
  bots: [],
  workflow: { mode: 'solo' },
  is_active: true,
  user_id: 0,
  created_at: '2026-05-27T00:00:00',
  updated_at: '2026-05-27T00:00:00',
}
let mockTeams = [mockDiscoverAssistantTeam]
let mockIsTeamsLoading = false

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getDiscoveryConfig: jest.fn(),
    listListings: jest.fn(),
    getListing: jest.fn(),
    installListing: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: mockTeams,
    isTeamsLoading: mockIsTeamsLoading,
    refreshTeams: mockRefreshTeams,
  }),
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: ({
    selectedTeamForNewTask,
    hideSelectors,
    showRepositorySelector,
    taskType,
    emptyStateContent,
  }: {
    selectedTeamForNewTask?: { name: string } | null
    hideSelectors?: boolean
    showRepositorySelector?: boolean
    taskType?: string
    emptyStateContent?: ReactNode
  }) => (
    <div
      data-testid="discover-assistant-chat-area"
      data-team-name={selectedTeamForNewTask?.name ?? ''}
      data-hide-selectors={String(Boolean(hideSelectors))}
      data-show-repository-selector={String(Boolean(showRepositorySelector))}
      data-task-type={taskType}
    >
      {emptyStateContent}
    </div>
  ),
}))

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DrawerHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerClose: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'actions.install': '接受分享',
        'actions.installed': '已接受',
        'actions.details': '详情',
        'actions.view_usage': '查看用法',
        'actions.retry': '重试',
        'actions.search': '搜索',
        'discover.card.no_tags': '暂无标签',
        'discover.card.solution_label': '可复用方案',
        'discover.card.best_for': '适合',
        'discover.card.start_hint': '接受后在我的资源中使用',
        'discover.description': '按使用场景浏览团队沉淀的可复用方案，查看用法后接受分享。',
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
        'discover.title': '发现可复用方案',
        'detail.sections.solves': '它解决什么',
        'detail.sections.get_started': '怎么开始',
        'detail.sections.examples': '示例输入',
        'detail.sections.resource_info': '资源信息',
        'detail.start_steps.accept': '接受这个方案',
        'detail.start_steps.open_mine': '在我的资源中找到对应资源',
        'detail.start_steps.use': '按你的任务场景开始使用',
        'detail.example_prompt': '用 {{title}} 帮我处理一个实际任务',
        'fields.install_count': '接受次数',
        'fields.publisher': '发布者',
        'fields.updated_at': '更新时间',
        'search.placeholder': '搜索资源',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
        'messages.install_success': '已接受分享',
        title: '资源库',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

function createListing(overrides: Partial<ResourceLibraryListing> = {}): ResourceLibraryListing {
  return {
    id: 1,
    resource_type: 'skill',
    name: 'doc-summary',
    display_name: 'Doc Summary',
    description: 'Summarizes documents',
    icon: null,
    tags: ['docs'],
    publisher_user_id: 3,
    status: 'published',
    current_version_id: 10,
    current_version: {
      id: 10,
      listing_id: 1,
      version: '1.0.0',
      created_at: '2026-05-27T00:00:00',
    },
    install_count: 4,
    is_installed: false,
    created_at: '2026-05-27T00:00:00',
    updated_at: '2026-05-27T00:00:00',
    ...overrides,
  }
}

describe('DiscoverResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorage.clear()
    mockTeams = [mockDiscoverAssistantTeam]
    mockIsTeamsLoading = false
    mockResourceLibraryApi.getDiscoveryConfig.mockResolvedValue({
      knowledge_base_ref: {
        id: 12,
        name: '资源库',
        namespace: 'company',
      },
      assistant_team_ref: {
        name: 'resource-discovery-assistant',
        namespace: 'default',
      },
    })
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [createListing()],
      total: 1,
    })
    mockResourceLibraryApi.getListing.mockResolvedValue(createListing())
    mockResourceLibraryApi.installListing.mockResolvedValue({
      id: 9,
      listing_id: 1,
      version_id: 10,
      user_id: 2,
      resource_type: 'skill',
      installed_kind_id: 12,
      installed_reference: { namespace: 'default', name: 'doc-summary' },
      install_status: 'installed',
      requires_configuration: false,
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })
  })

  it('loads discover listings as a type-agnostic solution market', async () => {
    render(<DiscoverResources />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
      resourceType: 'all',
      page: 1,
      limit: 50,
    })
    expect(screen.getByText('Doc Summary')).toHaveClass('text-text-primary')
    expect(screen.getByTestId('resource-listing-card-1')).toBeInTheDocument()
    expect(screen.getByText('可复用方案')).toBeInTheDocument()
    expect(screen.getByText('适合')).toBeInTheDocument()
    expect(screen.getByText('接受后在我的资源中使用')).toBeInTheDocument()
    expect(screen.getByText('技能')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接受分享 Doc Summary' })).toBeEnabled()
  })

  it('does not render resource type controls as the primary market filter', async () => {
    render(<DiscoverResources />)

    const toolbar = screen.getByTestId('discover-resources-toolbar')
    expect(screen.queryByTestId('resource-page-filter-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('discover-type-filter')).not.toBeInTheDocument()
    expect(within(toolbar).getByTestId('resource-library-search-input')).toBeInTheDocument()
    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
  })

  it('keeps discover search in the resource section actions', async () => {
    render(<DiscoverResources />)

    const headerActions = screen.getByTestId('resource-page-header-actions')
    const toolbar = screen.getByTestId('discover-resources-toolbar')

    expect(screen.getByTestId('resource-market-section')).toBeInTheDocument()
    expect(within(headerActions).getByTestId('open-discover-assistant-button')).toBeInTheDocument()
    expect(within(headerActions).getByTestId('discover-resources-toolbar')).toBeInTheDocument()
    expect(toolbar).toHaveClass('w-full')
    expect(toolbar).toHaveClass('sm:min-w-[420px]')
    expect(toolbar).toHaveClass('sm:flex-row')
    expect(toolbar).not.toHaveClass('rounded-lg')
    expect(toolbar).not.toHaveClass('bg-surface')
    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
  })

  it('opens discover assistant as the actual ChatArea agent', async () => {
    const docSummary = createListing({
      id: 1,
      display_name: '文档总结',
      description: '总结文档和知识库内容',
      tags: ['文档', '总结'],
      install_count: 1,
    })
    const codeReview = createListing({
      id: 2,
      resource_type: 'agent',
      name: 'code-review',
      display_name: '代码评审',
      description: '检查代码变更',
      tags: ['代码'],
      install_count: 9,
    })
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [docSummary, codeReview],
      total: 2,
    })
    mockResourceLibraryApi.getListing.mockResolvedValue(docSummary)

    render(<DiscoverResources />)

    expect(await screen.findByText('文档总结')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('open-discover-assistant-button'))

    const assistant = await screen.findByTestId('discover-assistant-drawer')
    expect(within(assistant).getByText('发现助手')).toBeInTheDocument()

    const chatArea = within(assistant).getByTestId('discover-assistant-chat-area')
    expect(chatArea).toHaveAttribute('data-team-name', 'resource-discovery-assistant')
    expect(chatArea).toHaveAttribute('data-hide-selectors', 'true')
    expect(chatArea).toHaveAttribute('data-show-repository-selector', 'false')
    expect(chatArea).toHaveAttribute('data-task-type', 'chat')
    expect(within(chatArea).getByTestId('discover-assistant-empty-state')).toHaveTextContent(
      '让发现助手帮你找资源'
    )
  })

  it('opens discover assistant from a quick prompt and preloads the chat input', async () => {
    render(<DiscoverResources />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '找文档总结技能' }))

    const pendingPrompt = JSON.parse(sessionStorage.getItem('pendingTaskPrompt') ?? '{}')
    expect(pendingPrompt.prompt).toBe('找文档总结技能')
    expect(await screen.findByTestId('discover-assistant-chat-area')).toHaveAttribute(
      'data-team-name',
      'resource-discovery-assistant'
    )
  })

  it('opens listing details and installs from the drawer', async () => {
    render(<DiscoverResources />)

    await screen.findByText('Doc Summary')
    fireEvent.click(screen.getByRole('button', { name: '查看用法 Doc Summary' }))

    const dialog = await screen.findByRole('dialog')
    expect(mockResourceLibraryApi.getListing).toHaveBeenCalledWith(1)
    expect(within(dialog).getByText('Summarizes documents')).toBeInTheDocument()
    expect(within(dialog).getByText('它解决什么')).toBeInTheDocument()
    expect(within(dialog).getByText('怎么开始')).toBeInTheDocument()
    expect(within(dialog).getByText('示例输入')).toBeInTheDocument()
    expect(within(dialog).getByText('资源信息')).toBeInTheDocument()
    expect(within(dialog).getByText('接受这个方案')).toBeInTheDocument()
    expect(within(dialog).getByText('在我的资源中找到对应资源')).toBeInTheDocument()
    expect(within(dialog).getByText('按你的任务场景开始使用')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '接受分享 Doc Summary' }))

    await waitFor(() => {
      expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(1, {})
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '已接受分享' })
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledTimes(2)
  })
})
