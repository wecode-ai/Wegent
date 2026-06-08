// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'

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
        'discover.description': '按使用场景浏览团队沉淀的可复用方案，查看用法后接受分享。',
        'discover.title': '发现可复用方案',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'actions.details': '详情',
        'actions.install': '接受分享',
        'actions.installed': '已接受',
        'actions.close': '关闭',
        'search.placeholder': '搜索资源',
        'actions.search': '搜索',
        'actions.publish': '发布资源',
        'actions.retry': '重试',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

function setResourceLibraryUrl(search = '') {
  window.history.pushState({}, '', `/resource-library${search}`)
}

describe('ResourceLibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setResourceLibraryUrl()
    mockResourceLibraryApi.listListings.mockResolvedValue({ items: [], total: 0 })
  })

  it('renders discover as the default resource library view', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('resource-type-all-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-type-agent-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-type-skill-filter')).not.toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toBeInTheDocument()
    expect(screen.queryByTestId('my-resource-management')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
        resourceType: 'all',
        page: 1,
        limit: 50,
      })
    })
  })

  it('switches to my resources and updates the tab query parameter', async () => {
    render(<ResourceLibraryPage />)

    fireEvent.click(screen.getByTestId('resource-library-mine-tab'))

    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('my-resource-management')).toBeInTheDocument()
    expect(screen.queryByTestId('discover-resources')).not.toBeInTheDocument()
    expect(window.location.search).toContain('tab=mine')
  })

  it('opens my resources when the initial tab query parameter is mine', () => {
    setResourceLibraryUrl('?tab=mine&type=agent&scope=personal')

    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('my-resource-management')).toBeInTheDocument()
    expect(screen.queryByTestId('discover-resources')).not.toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).not.toHaveBeenCalled()
  })

  it('keeps discover market type-agnostic and loads all listings once', async () => {
    render(<ResourceLibraryPage />)

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
        resourceType: 'all',
        page: 1,
        limit: 50,
      })
    })
    expect(screen.queryByTestId('resource-page-filter-bar')).not.toBeInTheDocument()
  })
})
