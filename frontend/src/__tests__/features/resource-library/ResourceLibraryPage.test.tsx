// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { listGroups } from '@/apis/groups'
import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/resource-library',
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn().mockResolvedValue({
    items: [
      {
        id: 1,
        name: 'platform',
        display_name: 'Platform',
        my_role: 'Developer',
      },
    ],
  }),
}))

jest.mock('@/features/resource-library/components/MyResources', () => ({
  MyResources: ({
    createRequest,
    fixedSource,
    fixedGroup,
    allowedTypes,
    searchQuery,
    onCreateRequestClose,
    onResourceCreated,
  }: {
    createRequest?: { target: { scope: string }; publishAfterCreate?: boolean }
    fixedSource?: string
    fixedGroup?: string | null
    allowedTypes?: string[]
    searchQuery?: string
    onCreateRequestClose?: () => void
    onResourceCreated?: () => void
  }) => (
    <div
      data-testid="my-resource-management"
      data-fixed-source={fixedSource ?? ''}
      data-fixed-group={fixedGroup ?? ''}
      data-types={allowedTypes?.join(',') ?? ''}
      data-search-query={searchQuery ?? ''}
    >
      {createRequest
        ? `${createRequest.target.scope}${createRequest.publishAfterCreate ? '-market' : ''}`
        : '资源管理'}
      {createRequest && (
        <>
          <button
            type="button"
            data-testid="cancel-resource-creation"
            onClick={onCreateRequestClose}
          >
            取消创建
          </button>
          <button
            type="button"
            data-testid="complete-resource-creation"
            onClick={onResourceCreated}
          >
            完成创建
          </button>
        </>
      )}
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/DiscoverResources', () => ({
  DiscoverResources: ({
    resourceType,
    targetNamespace,
    systemOnly,
  }: {
    resourceType: string
    targetNamespace?: string
    systemOnly?: boolean
  }) => (
    <div
      data-testid="discover-resources"
      data-type={resourceType}
      data-target-namespace={targetNamespace ?? ''}
      data-system-only={String(Boolean(systemOnly))}
    >
      发现能力
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/FeaturedScenarios', () => ({
  FeaturedScenarios: () => <div data-testid="featured-scenarios">系统智能体</div>,
}))

jest.mock('@/features/resource-library/components/InstalledResources', () => ({
  InstalledResources: ({
    resourceType,
    keyword,
    groupNamespaces,
  }: {
    resourceType: string
    keyword?: string
    groupNamespaces?: string[]
  }) => (
    <div
      data-testid="installed-resources"
      data-type={resourceType}
      data-keyword={keyword ?? ''}
      data-group-namespaces={groupNamespaces?.join(',') ?? ''}
    >
      已添加能力
    </div>
  ),
}))

jest.mock('@/features/settings/components/SkillListWithScope', () => ({
  SkillListWithScope: ({
    selectedGroup,
    searchQuery,
  }: {
    selectedGroup?: string | null
    searchQuery?: string
  }) => (
    <div
      data-testid="group-skill-management"
      data-selected-group={selectedGroup ?? ''}
      data-search-query={searchQuery ?? ''}
    >
      团队技能管理
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/PublishedResources', () => ({
  PublishedResources: () => <div data-testid="published-resources">我的发布</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        title: '资源库',
        description: '发现团队与社区发布的能力',
        'mine.title': '我的能力',
        'mine.description': '管理你创建、团队共享或添加的能力',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'market_filters.agent': '智能体市场',
        'market_filters.skill': '技能市场',
        'filters.model': '模型',
        'filters.shell': '执行器',
        'filters.retriever': '检索器',
        'sources.all': '全部',
        'sources.mine': '我创建的',
        'sources.personal': '我创建的',
        'sources.group': '团队共享',
        'sources.installed': '已添加',
        'sources.system': '系统内置',
        'sources.all_groups': '全部团队',
        'search.placeholder': '搜索资源',
        'search.agent_placeholder': '搜索智能体或描述',
        'search.skill_placeholder': '搜索技能',
        'search.model_placeholder': '搜索模型名称',
        'search.shell_placeholder': '搜索执行器名称',
        'search.retriever_placeholder': '搜索检索器名称',
        'actions.search': '搜索',
        'actions.clear_search': '清除搜索',
        'actions.new_capability': '新建能力',
        'actions.my_capabilities': '我的能力',
        'actions.back_to_library': '返回资源库',
        'actions.view_capabilities': '查看当前能力',
        'actions.add_capability': '从资源库添加',
        'actions.retry': '重试',
        'fields.type': '类型',
        'fields.source': '来源',
        'fields.team_scope': '团队范围',
        'new_capability.common': '常用',
        'new_capability.advanced': '高级',
        'new_capability.advanced_description': '模型、执行器与检索器',
        'new_capability.type_descriptions.agent': '创建智能体',
        'new_capability.type_descriptions.skill': '上传技能',
        'new_capability.type_descriptions.model': '配置模型',
        'new_capability.type_descriptions.shell': '配置执行环境',
        'new_capability.type_descriptions.retriever': '配置检索服务',
        'states.loading': '正在加载资源',
        'states.error': '加载失败',
      }
      return translations[key] ?? key
    },
  }),
}))

const mockedListGroups = listGroups as jest.MockedFunction<typeof listGroups>

describe('ResourceLibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
  })

  it('shows system-only agent and skill marketplaces', () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-view-toggle')).toHaveTextContent('我的能力')
    expect(screen.getByRole('tab', { name: '智能体市场' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tab', { name: '技能市场' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '模型' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-source-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-header-search')).not.toBeInTheDocument()
    expect(screen.getByTestId('featured-scenarios')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-type', 'agent')
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-system-only', 'true')
    expect(screen.getByTestId('resource-type-navigation')).toHaveClass(
      'rounded-none',
      'bg-transparent'
    )
  })

  it('shows only system resources in the skill marketplace', () => {
    mockSearchParams = new URLSearchParams('type=skill')
    render(<ResourceLibraryPage />)

    expect(screen.queryByTestId('featured-scenarios')).not.toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-type', 'skill')
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-system-only', 'true')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('moves all management types and source filtering into My Capabilities', () => {
    mockSearchParams = new URLSearchParams('tab=mine')
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '我的能力' })).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-view-toggle')).toHaveTextContent('返回资源库')
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      '智能体',
      '技能',
      '模型',
      '执行器',
      '检索器',
    ])
    expect(screen.queryByRole('tab', { name: '连接器' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-source-select')).toHaveTextContent('我创建的')
    expect(screen.getByTestId('resource-library-source-select')).toHaveClass('sm:hidden')
    expect(screen.getByTestId('resource-library-source-segments')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-source-all-button')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('resource-library-source-mine-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('resource-library-source-group-button')).toHaveTextContent('团队共享')
    expect(screen.getByTestId('resource-library-source-installed-button')).toHaveTextContent(
      '已添加'
    )
    expect(screen.getByTestId('resource-type-agent-filter')).toHaveClass(
      'h-11',
      'after:bottom-1',
      'data-[state=active]:after:bg-primary'
    )
    expect(
      screen.getByTestId('resource-type-navigation').parentElement?.parentElement
    ).not.toHaveClass('sm:min-h-14')
    expect(screen.getByTestId('resource-library-source-select')).toHaveClass('h-11')
    expect(screen.getByTestId('resource-library-source-select')).not.toHaveClass('lg:h-10')
    expect(screen.getByTestId('resource-library-header-search-input')).toHaveClass('h-11')
    expect(screen.getByTestId('resource-library-header-search-input')).not.toHaveClass('lg:h-10')
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'mine'
    )
  })

  it.each([
    ['model', '搜索模型名称'],
    ['shell', '搜索执行器名称'],
    ['retriever', '搜索检索器名称'],
  ])('uses a resource-specific search placeholder for %s', (type, placeholder) => {
    mockSearchParams = new URLSearchParams(`tab=mine&type=${type}`)
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-header-search-input')).toHaveAttribute(
      'placeholder',
      placeholder
    )
  })

  it('uses created-by-me filtering for skills', () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=skill')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-source-mine-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'mine'
    )
  })

  it('toggles between the resource library and My Capabilities', async () => {
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('resource-library-view-toggle'))
    expect(mockReplace).toHaveBeenCalledWith('/resource-library?tab=mine', { scroll: false })

    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('tab=mine&type=model&source=group')
    render(<ResourceLibraryPage />)
    await user.click(screen.getAllByTestId('resource-library-view-toggle')[1])
    expect(mockReplace).toHaveBeenCalledWith('/resource-library?type=agent', { scroll: false })
  })

  it('uses the added resource endpoint only for agents and skills', () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=skill&source=installed&keyword=docs')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('installed-resources')).toHaveAttribute('data-type', 'skill')
    expect(screen.getByTestId('installed-resources')).toHaveAttribute('data-keyword', 'docs')
    expect(screen.queryByTestId('my-resource-management')).not.toBeInTheDocument()
  })

  it('normalizes unsupported added filters for foundation resources', async () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=model&source=installed')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'personal'
    )
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/resource-library?tab=mine&type=model&source=personal',
        {
          scroll: false,
        }
      )
    )
  })

  it('shows system resources as a dedicated source for foundation capabilities', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('tab=mine&type=retriever&source=system')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-source-select')).toHaveTextContent('系统内置')
    expect(screen.getByTestId('resource-library-source-system-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.queryByTestId('resource-library-source-installed-button')).toBeNull()
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'system'
    )

    await user.click(screen.getByTestId('resource-library-source-select'))
    expect(screen.getByTestId('resource-library-source-system-option')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-source-installed-option')).not.toBeInTheDocument()
  })

  it('changes the source from the desktop segmented filter', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('tab=mine&type=agent')
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('resource-library-source-mine-button'))

    expect(mockReplace).toHaveBeenCalledWith('/resource-library?tab=mine&type=agent&source=mine', {
      scroll: false,
    })
  })

  it('normalizes unsupported system filters for agents and skills', async () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=agent&source=system')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'mine'
    )
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/resource-library?tab=mine&type=agent&source=mine',
        {
          scroll: false,
        }
      )
    )
  })

  it('shows a contextual team selector for team-shared resources', async () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=skill&source=group')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-team-select')).toHaveTextContent('全部团队')
    expect(screen.getByTestId('resource-library-team-select')).toHaveClass('h-11')
    expect(screen.getByTestId('resource-library-team-select')).not.toHaveClass('lg:h-10')
    await waitFor(() => expect(mockedListGroups).toHaveBeenCalledWith({ page: 1, limit: 100 }))
    await waitFor(() =>
      expect(screen.getByTestId('installed-resources')).toHaveAttribute(
        'data-group-namespaces',
        'platform'
      )
    )
  })

  it('shows native team agents with the editable resource manager', async () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=agent&source=group&group=platform')
    render(<ResourceLibraryPage />)

    const manager = screen.getByTestId('my-resource-management')
    expect(manager).toHaveAttribute('data-fixed-source', 'group')
    expect(manager).toHaveAttribute('data-fixed-group', 'platform')
    expect(manager).toHaveAttribute('data-types', 'agent')
    expect(screen.queryByTestId('installed-resources')).not.toBeInTheDocument()
  })

  it('truncates a long selected team name and exposes the full name as a tooltip', async () => {
    const longGroupName = '这是一个很长的子组名字---001'
    mockedListGroups.mockResolvedValueOnce({
      items: [
        {
          id: 2,
          name: 'long-team',
          display_name: longGroupName,
          my_role: 'Developer',
        },
      ],
    } as Awaited<ReturnType<typeof listGroups>>)
    mockSearchParams = new URLSearchParams('tab=mine&type=agent&source=group&group=long-team')
    render(<ResourceLibraryPage />)

    const teamSelect = screen.getByTestId('resource-library-team-select')
    await waitFor(() => expect(teamSelect).toHaveAttribute('title', longGroupName))
    expect(teamSelect.firstElementChild).toHaveClass('min-w-0', 'flex-1', 'truncate', 'text-left')
  })

  it('keeps legacy scope links working and normalizes them to source', async () => {
    mockSearchParams = new URLSearchParams('tab=mine&type=model&scope=personal')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'personal'
    )
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/resource-library?tab=mine&type=model&source=personal',
        { scroll: false }
      )
    )
  })

  it('shows a retry state when team scopes cannot be loaded', async () => {
    const user = userEvent.setup()
    mockedListGroups.mockRejectedValueOnce(new Error('group failure'))
    mockSearchParams = new URLSearchParams('tab=mine&type=skill&source=group')
    render(<ResourceLibraryPage />)

    expect(await screen.findByTestId('team-resources-error')).toHaveTextContent('加载失败')
    await user.click(screen.getByTestId('team-resources-retry-button'))
    await waitFor(() =>
      expect(screen.getByTestId('installed-resources')).toHaveAttribute(
        'data-group-namespaces',
        'platform'
      )
    )
  })

  it('opens resource discovery in the context of one selected team', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('tab=mine&type=skill&source=group&group=platform')
    const { unmount } = render(<ResourceLibraryPage />)

    expect(screen.getByTestId('installed-resources')).toHaveAttribute(
      'data-group-namespaces',
      'platform'
    )
    await user.click(await screen.findByTestId('resource-library-team-add-button'))
    expect(mockReplace).toHaveBeenCalledWith(
      '/resource-library?tab=mine&type=skill&source=group&group=platform&teamAction=add',
      { scroll: false }
    )

    unmount()
    mockSearchParams = new URLSearchParams(
      'tab=mine&type=skill&source=group&group=platform&teamAction=add'
    )
    render(<ResourceLibraryPage />)

    expect(await screen.findByTestId('discover-resources')).toHaveAttribute(
      'data-target-namespace',
      'platform'
    )
    expect(screen.getByTestId('resource-library-team-current-button')).toBeInTheDocument()
  })

  it('does not offer team additions to read-only team members', async () => {
    mockedListGroups.mockResolvedValueOnce({
      items: [
        {
          id: 1,
          name: 'platform',
          display_name: 'Platform',
          my_role: 'Reporter',
        },
      ],
    } as Awaited<ReturnType<typeof listGroups>>)
    mockSearchParams = new URLSearchParams(
      'tab=mine&type=skill&source=group&group=platform&teamAction=add'
    )
    render(<ResourceLibraryPage />)

    await waitFor(() =>
      expect(screen.getByTestId('resource-library-team-select')).toHaveTextContent('Platform')
    )
    expect(screen.queryByTestId('resource-library-team-add-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-team-current-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('discover-resources')).not.toBeInTheDocument()
    expect(screen.getByTestId('installed-resources')).toHaveAttribute(
      'data-group-namespaces',
      'platform'
    )
  })

  it('persists the applied search and clears it from the compact search control', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('tab=mine')
    render(<ResourceLibraryPage />)

    fireEvent.change(screen.getByTestId('resource-library-header-search-input'), {
      target: { value: '  chat  ' },
    })
    fireEvent.submit(screen.getByTestId('resource-library-header-search'))
    expect(mockReplace).toHaveBeenCalledWith('/resource-library?tab=mine&keyword=chat', {
      scroll: false,
    })

    expect(screen.getByTestId('resource-library-header-search-input')).toHaveClass('pr-12')
    const clearButton = screen.getByTestId('resource-library-header-search-clear')
    expect(clearButton).toHaveClass('h-11', 'w-11')
    await user.click(clearButton)
    expect(mockReplace).toHaveBeenLastCalledWith('/resource-library?tab=mine', { scroll: false })
  })

  it('keeps common creation types visible and foundation resources under Advanced', async () => {
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('new-capability-button'))
    expect(screen.getByTestId('new-capability-type-agent')).toBeInTheDocument()
    expect(screen.getByTestId('new-capability-type-skill')).toBeInTheDocument()
    expect(screen.getByTestId('new-capability-advanced')).toBeInTheDocument()
    expect(screen.queryByTestId('new-capability-type-model')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('new-capability-advanced'))
    expect(screen.getByTestId('new-capability-advanced')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('new-capability-advanced-content')).toBeVisible()
    expect(screen.getByTestId('new-capability-type-model')).toBeVisible()
    expect(screen.getByTestId('new-capability-type-shell')).toBeVisible()
    expect(screen.getByTestId('new-capability-type-retriever')).toBeVisible()

    await user.click(screen.getByTestId('new-capability-type-agent'))
    expect(await screen.findByTestId('my-resource-management')).toHaveTextContent('personal')
  })

  it('maps the legacy team deep link into the team-shared My Capabilities view', async () => {
    mockSearchParams = new URLSearchParams('tab=team&type=skill')
    render(<ResourceLibraryPage />)

    await waitFor(() =>
      expect(screen.getByTestId('installed-resources')).toHaveAttribute(
        'data-group-namespaces',
        'platform'
      )
    )
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/resource-library?tab=mine&type=skill&source=group',
        { scroll: false }
      )
    )
  })

  it('keeps published deep links working without exposing another navigation layer', () => {
    mockSearchParams = new URLSearchParams('tab=published&type=agent')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('published-resources')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-type-navigation')).not.toBeInTheDocument()
  })
})
