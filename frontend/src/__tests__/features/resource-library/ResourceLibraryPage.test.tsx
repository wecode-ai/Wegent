// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { listGroups } from '@/apis/groups'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
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

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listListings: jest.fn().mockResolvedValue({
      items: [],
      has_more: false,
      next_cursor: null,
      limit: 20,
    }),
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

jest.mock('@/features/resource-library/components/MyResources', () => ({
  MyResources: ({
    createRequest,
    hideTypeControls,
    fixedSource,
    hideManagerCreateActions,
    hideSortControls,
    hideTeamModeFilter,
    teamModeFilter,
    modelCategoryFilter,
    hideModelCategoryFilter,
    allowedTypes,
    onCreateRequestClose,
    onResourceCreated,
  }: {
    createRequest?: { target: { scope: string }; publishAfterCreate?: boolean }
    hideTypeControls?: boolean
    fixedSource?: string
    hideManagerCreateActions?: boolean
    hideSortControls?: boolean
    hideTeamModeFilter?: boolean
    teamModeFilter?: string
    modelCategoryFilter?: string
    hideModelCategoryFilter?: boolean
    allowedTypes?: string[]
    onCreateRequestClose?: () => void
    onResourceCreated?: () => void
  }) => (
    <div
      data-testid="my-resource-management"
      data-hide-type-controls={hideTypeControls ? 'true' : 'false'}
      data-fixed-source={fixedSource ?? ''}
      data-hide-manager-create-actions={hideManagerCreateActions ? 'true' : 'false'}
      data-hide-sort-controls={hideSortControls ? 'true' : 'false'}
      data-hide-team-mode-filter={hideTeamModeFilter ? 'true' : 'false'}
      data-team-mode-filter={teamModeFilter ?? ''}
      data-model-category-filter={modelCategoryFilter ?? ''}
      data-hide-model-category-filter={hideModelCategoryFilter ? 'true' : 'false'}
      data-types={allowedTypes?.join(',') ?? ''}
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
  DiscoverResources: ({ resourceType }: { resourceType: string }) => (
    <div data-testid="discover-resources" data-type={resourceType}>
      发现能力
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/TeamCapabilities', () => ({
  TeamCapabilities: ({
    createRequest,
    groupStatus,
    modelCategoryFilter,
    teamSelection,
  }: {
    createRequest?: { target: { groupName?: string } }
    groupStatus?: string
    modelCategoryFilter?: string
    teamSelection?: { all: boolean; groupNames: string[] }
  }) => (
    <div
      data-testid="team-capabilities"
      data-group-status={groupStatus ?? ''}
      data-model-category-filter={modelCategoryFilter ?? ''}
      data-team-filter={teamSelection?.all ? 'all' : teamSelection?.groupNames.join(',') || ''}
    >
      {createRequest?.target.groupName || '团队能力'}
    </div>
  ),
}))

jest.mock('@/features/resource-library/components/PublishedResources', () => ({
  PublishedResources: () => <div data-testid="published-resources">我的发布</div>,
}))

jest.mock('@/features/settings/components/TeamListWithScope', () => ({
  TeamListWithScope: ({
    createRequest,
  }: {
    createRequest?: { target: { scope: string }; publishAfterCreate?: boolean }
  }) => (
    <div data-testid="agent-creation-host">
      {createRequest
        ? `${createRequest.target.scope}${createRequest.publishAfterCreate ? '-market' : ''}`
        : ''}
    </div>
  ),
}))

jest.mock('@/features/settings/components/SkillListWithScope', () => ({
  SkillListWithScope: ({ createRequest }: { createRequest?: { target: { scope: string } } }) => (
    <div data-testid="skill-creation-host">{createRequest?.target.scope || ''}</div>
  ),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        title: '资源库',
        description: '发现、安装和管理能力',
        'tabs.discover': '发现',
        'tabs.mine': '我的',
        'tabs.team': '团队',
        'tabs.system': '系统',
        'tabs.installed': '已安装',
        'tabs.published': '我发布的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'filters.model': '模型',
        'filters.shell': '执行器',
        'filters.retriever': '检索器',
        'search.placeholder': '搜索资源',
        'actions.search': '搜索',
        'actions.filter': '筛选',
        'actions.publish': '发布资源',
        'actions.new_capability': '新建能力',
        'actions.retry': '重试',
        'fields.type': '类型',
        'fields.scope': '范围',
        'fields.mode': '模式',
        'fields.sort': '排序',
        'sort.default': '默认',
        'sort.popular': '最热',
        'sort.latest': '最新',
        'modes.all': '全部模式',
        'modes.chat': '聊天',
        'modes.code': '编码',
        'modes.task': '设备',
        'models.filter_by_category_type': '模型类型',
        'models.all_category_types': '全部类型',
        'models.model_category_type_llm': 'LLM（对话/代码）',
        'models.model_category_type_embedding': '向量嵌入（Embedding）',
        'models.model_category_type_rerank': '重排序（Rerank）',
        'new_capability.description': '选择能力类型，发布范围在新建页面中设置',
        'new_capability.core_resources': '核心能力',
        'new_capability.foundation_resources': '基础资源',
        'new_capability.type_descriptions.agent': '创建可对话和协作的智能体',
        'new_capability.type_descriptions.skill': '上传可复用的技能包',
        'new_capability.type_descriptions.model': '配置模型服务',
        'new_capability.type_descriptions.shell': '配置执行环境',
        'new_capability.type_descriptions.retriever': '配置检索服务',
        'states.loading': '正在加载资源',
        'states.error': '加载失败',
        'states.empty': '暂无资源',
        'states.no_groups': '暂无团队',
        'sources.all_groups': '全部团队',
        'search.groups_placeholder': '搜索团队',
        'search.groups_empty': '没有匹配的团队',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>
const mockedListGroups = listGroups as jest.MockedFunction<typeof listGroups>

describe('ResourceLibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
  })

  it('uses resource type as the primary navigation and discovers agents by default', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '管理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '智能体' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('resource-library-header')).not.toHaveClass(
      'rounded-2xl',
      'border',
      'bg-surface'
    )
    expect(screen.getByTestId('resource-type-navigation')).toHaveClass(
      'inline-flex',
      'w-fit',
      'rounded-xl',
      'bg-muted/60'
    )
    expect(screen.getByTestId('resource-type-agent-filter')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('resource-type-agent-filter')).toHaveClass(
      'data-[state=active]:border-border',
      'data-[state=active]:bg-surface',
      'data-[state=active]:shadow-sm'
    )
    expect(
      screen.getByTestId('resource-type-agent-filter').querySelector('.lucide-bot')
    ).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-source-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-team-tab')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-published-tab')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-header-search')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-header-search-input')).toHaveClass(
      'border-border',
      'bg-surface'
    )
    expect(screen.queryByTestId('resource-library-marketplace-sort')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '执行器' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '检索器' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
    expect(await screen.findByTestId('discover-resources')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-type', 'agent')
    expect(mockResourceLibraryApi.listListings).not.toHaveBeenCalled()
    expect(mockResourceLibraryApi.listMyInstalls).not.toHaveBeenCalled()
  })

  it('opens the agent creator directly without changing tabs', async () => {
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('new-capability-button'))
    expect(screen.queryByTestId('new-capability-target-mine')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('new-capability-type-agent'))

    expect(await screen.findByTestId('my-resource-management')).toHaveTextContent('personal')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('reloads the visible resource manager after creating a capability', async () => {
    mockSearchParams = new URLSearchParams('tab=mine')
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    const visibleManager = screen.getByTestId('my-resource-management')

    await user.click(screen.getByTestId('new-capability-button'))
    await user.click(screen.getByTestId('new-capability-type-agent'))
    await user.click(screen.getByTestId('complete-resource-creation'))

    expect(screen.getByTestId('my-resource-management')).not.toBe(visibleManager)
  })

  it('shows one resource manager at a time on my capabilities', () => {
    mockSearchParams = new URLSearchParams('tab=mine')

    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-hide-type-controls',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-fixed-source',
      'personal'
    )
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-hide-manager-create-actions',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-hide-sort-controls',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toHaveAttribute(
      'data-hide-team-mode-filter',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '智能体' })).toHaveAttribute('aria-pressed', 'true')
    expect(mockResourceLibraryApi.listMyInstalls).not.toHaveBeenCalled()
  })

  it('uses marketplace lifecycle tabs for every resource type', async () => {
    mockSearchParams = new URLSearchParams('tab=team&type=all')
    const { rerender } = render(<ResourceLibraryPage />)

    await waitFor(() =>
      expect(screen.getByTestId('team-capabilities')).toHaveAttribute('data-group-status', 'ready')
    )
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '智能体' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('resource-library-team-tab')).toHaveAttribute('aria-selected', 'true')

    mockSearchParams = new URLSearchParams('tab=published&type=model')
    rerender(<ResourceLibraryPage />)

    expect(screen.getByRole('tab', { name: '模型' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: '管理' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-published-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('published-resources')).toBeInTheDocument()
  })

  it('keeps foundation resources in marketplace discovery', async () => {
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    await user.click(screen.getByRole('tab', { name: '模型' }))

    expect(mockReplace).toHaveBeenCalledWith('/resource-library?type=model&tab=discover', {
      scroll: false,
    })
  })

  it('clears marketplace-only filters when leaving discover', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams(
      'type=agent&tab=discover&keyword=chat&marketSort=popular'
    )
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('resource-library-mine-tab'))

    expect(mockReplace).toHaveBeenCalledWith('/resource-library?type=agent&tab=mine', {
      scroll: false,
    })
  })

  it('uses lightweight source tabs and a direct agent mode selector', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('type=agent&tab=mine')
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('resource-library-discover-tab')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-team-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-system-tab')).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-published-tab')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-mode-select')).toBeInTheDocument()

    await user.click(screen.getByTestId('resource-library-team-tab'))

    expect(mockReplace).toHaveBeenCalledWith('/resource-library?type=agent&tab=team', {
      scroll: false,
    })

    expect(screen.getByTestId('resource-library-mode-select')).toHaveTextContent('全部模式')
  })

  it('shows team scope as a contextual team selector', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('type=skill&tab=team')
    render(<ResourceLibraryPage />)

    await user.click(await screen.findByTestId('resource-library-team-filter'))

    expect(await screen.findByTestId('resource-library-team-scope-menu')).toBeInTheDocument()
    expect(await screen.findByTestId('resource-library-team-all')).toHaveAttribute(
      'data-state',
      'checked'
    )
    await user.click(await screen.findByTestId('resource-library-team-platform'))

    expect(mockedListGroups).toHaveBeenCalledWith({ page: 1, limit: 100 })
    await waitFor(() =>
      expect(screen.getByTestId('team-capabilities')).toHaveAttribute(
        'data-team-filter',
        'platform'
      )
    )
  })

  it('does not render the old combined management filter', () => {
    mockSearchParams = new URLSearchParams('type=agent&tab=mine')
    render(<ResourceLibraryPage />)

    expect(screen.queryByTestId('resource-library-filter-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-library-filter-menu')).not.toBeInTheDocument()
  })

  it('uses a direct model category selector', async () => {
    mockSearchParams = new URLSearchParams('type=model&tab=team&modelCategory=embedding')
    render(<ResourceLibraryPage />)

    await waitFor(() =>
      expect(screen.getByTestId('team-capabilities')).toHaveAttribute('data-group-status', 'ready')
    )
    expect(screen.getByTestId('resource-library-model-category-select')).toHaveTextContent(
      '向量嵌入（Embedding）'
    )
    expect(screen.queryByTestId('resource-library-mode-all')).not.toBeInTheDocument()
    expect(screen.getByTestId('team-capabilities')).toHaveAttribute(
      'data-model-category-filter',
      'embedding'
    )
  })

  it('does not expose a separate system category for foundation resources', () => {
    mockSearchParams = new URLSearchParams('type=model&tab=system')

    render(<ResourceLibraryPage />)

    expect(screen.queryByTestId('resource-library-system-tab')).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('discover-resources')).toHaveAttribute('data-type', 'model')
  })

  it('opens the skill creator directly without a continue step', async () => {
    const user = userEvent.setup()
    render(<ResourceLibraryPage />)

    await user.click(screen.getByTestId('new-capability-button'))
    await user.click(screen.getByTestId('new-capability-type-skill'))

    expect(await screen.findByTestId('my-resource-management')).toHaveTextContent('personal')
    expect(screen.queryByTestId('new-capability-confirm')).not.toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('unmounts the auxiliary creator when skill creation is cancelled', async () => {
    const user = userEvent.setup()
    mockSearchParams = new URLSearchParams('type=skill&tab=mine')
    render(<ResourceLibraryPage />)

    expect(screen.getAllByTestId('my-resource-management')).toHaveLength(1)

    await user.click(screen.getByTestId('new-capability-button'))
    await user.click(screen.getByTestId('new-capability-type-skill'))

    expect(screen.getAllByTestId('my-resource-management')).toHaveLength(2)
    await user.click(screen.getByTestId('cancel-resource-creation'))

    expect(screen.getAllByTestId('my-resource-management')).toHaveLength(1)
  })
})
