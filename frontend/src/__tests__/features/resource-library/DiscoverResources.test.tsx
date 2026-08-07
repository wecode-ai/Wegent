// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { DiscoverResources } from '@/features/resource-library/components/DiscoverResources'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

const mockToast = jest.fn()
const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockObserve = jest.fn()
const mockUnobserve = jest.fn()
const mockDisconnect = jest.fn()
let mockSearchParams = new URLSearchParams()
let intersectionObserverCallback: IntersectionObserverCallback

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionObserverCallback = callback
  }

  observe = mockObserve
  unobserve = mockUnobserve
  disconnect = mockDisconnect
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  writable: true,
  value: MockIntersectionObserver,
})

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/resource-library',
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listListings: jest.fn(),
    getListing: jest.fn(),
    installListing: jest.fn(),
    getMarketplaceTags: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
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
        'actions.install': '安装',
        'actions.use': '立即使用',
        'actions.use_now': '立即使用',
        'actions.open_chat': '去对话',
        'actions.open_code': '去编码',
        'actions.add': '添加',
        'actions.added': '已添加',
        'actions.installed': '已添加',
        'actions.details': '详情',
        'actions.retry': '重试',
        'actions.search': '搜索',
        'fields.sort': '排序',
        'fields.install_count': '添加次数',
        'fields.people_added': '人添加',
        'fields.official_badge': '官方',
        'fields.publisher': '发布者',
        'fields.official_publisher': 'Wegent 官方',
        'fields.updated_at': '更新时间',
        'modes.chat': '聊天',
        'modes.code': '编码',
        'modes.task': '设备',
        'common:teams.go_to_chat': '去聊天',
        'common:teams.go_to_code': '去编码',
        'search.placeholder': '搜索资源',
        'search.agent_placeholder': '搜索智能体或描述',
        'search.skill_placeholder': '搜索技能',
        'sort.default': '默认',
        'sort.popular': '热门',
        'sort.latest': '最新',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
        'messages.install_success': '添加成功',
        'marketplace_tags.all': '全部',
        'marketplace_tags.featured': '精选',
      }

      return translations[key] ?? key
    },
    i18n: { language: 'zh-CN' },
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
    publisher_user_name: 'publisher-user',
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
    bind_modes: [],
    created_at: '2026-05-27T00:00:00',
    updated_at: '2026-05-27T00:00:00',
    ...overrides,
  }
}

describe('DiscoverResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [createListing()],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })
    mockResourceLibraryApi.getMarketplaceTags.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'technical_development',
          name_zh: '技术开发',
          name_en: 'Technical Development',
          sort: 10,
          enabled: true,
        },
      ],
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
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })
  })

  it('loads discover listings for the selected resource type', async () => {
    render(<DiscoverResources resourceType="skill" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
      resourceType: 'skill',
      targetNamespace: 'default',
      cursor: undefined,
      limit: 20,
    })
    expect(screen.getByTestId('resource-listing-card-1')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resource-grid')).toHaveClass(
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    expect(screen.getByTestId('resource-listing-card-1')).toHaveClass(
      'h-full',
      'p-4',
      'gap-3',
      'rounded-xl'
    )
    expect(screen.getByTestId('resource-listing-card-1')).not.toHaveClass('min-h-[190px]')
    const actionButton = screen.getByRole('button', { name: '添加 Doc Summary' })
    expect(actionButton).toBeEnabled()
    expect(actionButton).toHaveClass(
      'absolute',
      'right-3',
      'top-3',
      'h-11',
      'w-11',
      'px-0',
      'md:h-8',
      'md:w-8'
    )
    expect(actionButton).toHaveAttribute('title', '添加')
    expect(actionButton).not.toHaveTextContent('添加')
    const footer = screen.getByTestId('resource-listing-footer-1')
    expect(footer).toHaveClass('mt-auto')
    expect(screen.getByText('publisher-user')).toBeInTheDocument()
    expect(footer).not.toHaveClass('border-t')
    expect(footer).not.toHaveTextContent('2026-05-27')
    expect(footer).toHaveTextContent('4 人添加')
    expect(screen.getByText('docs')).toBeInTheDocument()
  })

  it('filters marketplace listings by configured tag', async () => {
    render(<DiscoverResources resourceType="skill" />)

    await screen.findByText('Doc Summary')
    const allTags = await screen.findByTestId('marketplace-tag-filter-all')
    const technicalDevelopment = await screen.findByTestId(
      'marketplace-tag-filter-technical_development'
    )
    expect(allTags).toHaveAttribute('aria-pressed', 'true')
    expect(technicalDevelopment).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(technicalDevelopment)

    await waitFor(() =>
      expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
        resourceType: 'skill',
        tags: ['technical_development'],
        targetNamespace: 'default',
        cursor: undefined,
        limit: 20,
      })
    )
    expect(mockReplace).toHaveBeenCalledWith('/resource-library?tag=technical_development', {
      scroll: false,
    })
    expect(allTags).toHaveAttribute('aria-pressed', 'false')
    expect(technicalDevelopment).toHaveAttribute('aria-pressed', 'true')
  })

  it('labels the unfiltered system marketplace as featured', async () => {
    render(<DiscoverResources resourceType="agent" systemOnly />)

    expect(await screen.findByTestId('marketplace-tag-filter-all')).toHaveTextContent('精选')
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
      resourceType: 'agent',
      featuredOnly: true,
      targetNamespace: 'default',
      cursor: undefined,
      limit: 20,
    })
  })

  it('uses the featured filter for the Skill marketplace', async () => {
    render(<DiscoverResources resourceType="skill" systemOnly />)

    expect(await screen.findByTestId('marketplace-tag-filter-all')).toHaveTextContent('精选')
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
      resourceType: 'skill',
      featuredOnly: true,
      targetNamespace: 'default',
      cursor: undefined,
      limit: 20,
    })
  })

  it('includes regular marketplace resources after selecting a category', async () => {
    render(<DiscoverResources resourceType="agent" systemOnly />)

    await screen.findByTestId('marketplace-tag-filter-all')
    fireEvent.click(screen.getByTestId('marketplace-tag-filter-technical_development'))

    await waitFor(() =>
      expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
        resourceType: 'agent',
        tags: ['technical_development'],
        targetNamespace: 'default',
        cursor: undefined,
        limit: 20,
      })
    )
  })

  it('omits missing publisher metadata without reserving a placeholder', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          publisher_user_name: null,
          publisher_namespace: undefined,
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="skill" />)

    const footer = await screen.findByTestId('resource-listing-footer-1')
    expect(screen.queryByText('publisher-user')).not.toBeInTheDocument()
    expect(footer).not.toHaveTextContent('#3')
    expect(footer).toHaveTextContent('4 人添加')
  })

  it('hides zero add counts without truncating Skill metadata', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [createListing({ publisher_user_id: 0, install_count: 0 })],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="skill" />)

    expect(await screen.findByText('Wegent 官方')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-footer-1')).not.toBeInTheDocument()
    expect(screen.queryByText('2026-05-27')).not.toBeInTheDocument()
    expect(screen.queryByText(/人添加/)).not.toBeInTheDocument()
  })

  it('keeps up to three tags and omits version and duplicate official metadata', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          publisher_user_id: 0,
          tags: ['technical_development', 'data_analysis', 'daily_work'],
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="skill" />)

    const card = await screen.findByTestId('resource-listing-card-1')
    expect(within(card).getByText('技术开发')).toBeInTheDocument()
    expect(within(card).getByText('data_analysis')).toBeInTheDocument()
    expect(within(card).getByText('daily_work')).toBeInTheDocument()
    expect(within(card).queryByText('v1.0.0')).not.toBeInTheDocument()
    expect(within(card).queryByText('官方')).not.toBeInTheDocument()
    expect(within(card).getAllByText('Wegent 官方')).toHaveLength(1)
    expect(within(card).getByTestId('install-resource-1-button')).toHaveClass(
      'border-primary/20',
      'bg-primary/[0.04]',
      'text-primary',
      'hover:bg-primary/[0.1]',
      'hover:shadow-md'
    )
  })

  it('uses the same four-column desktop grid for other resource types', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [createListing({ resource_type: 'agent', bind_modes: ['chat'] })],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="agent" />)

    expect(await screen.findByTestId('discover-resource-grid')).toHaveClass(
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    expect(screen.getByTestId('resource-listing-card-1')).toHaveClass('h-full')
    expect(screen.getByTestId('install-resource-1-button')).toHaveClass(
      'absolute',
      'right-3',
      'top-3',
      'h-11',
      'min-w-[44px]',
      'md:h-7',
      'bg-primary',
      'text-white',
      'md:opacity-0',
      'md:group-hover:opacity-100',
      'md:group-focus-within:opacity-100'
    )
  })

  it('renders leading filters in the marketplace toolbar', async () => {
    render(
      <DiscoverResources
        resourceType="skill"
        leadingFilterControls={<div data-testid="leading-team-filter">团队范围</div>}
      />
    )

    const toolbar = await screen.findByTestId('leading-team-filter')
    expect(toolbar).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-toolbar')).toHaveClass('rounded-xl', 'bg-surface')
    expect(screen.getByTestId('resource-library-search-input')).toHaveAttribute(
      'placeholder',
      '搜索技能'
    )
  })

  it('left-aligns tag filters when the search field is hidden', async () => {
    render(<DiscoverResources resourceType="agent" hideSearch />)

    expect(await screen.findByTestId('marketplace-tag-filter-all')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-toolbar')).toHaveClass('justify-start')
    expect(screen.getByTestId('marketplace-toolbar')).not.toHaveClass('justify-end')
  })

  it('persists an applied search in the URL and reloads the marketplace', async () => {
    render(<DiscoverResources resourceType="skill" />)

    await screen.findByText('Doc Summary')
    fireEvent.change(screen.getByTestId('resource-library-search-input'), {
      target: { value: '  docs  ' },
    })
    fireEvent.click(screen.getByTestId('resource-library-search-button'))

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
        resourceType: 'skill',
        keyword: 'docs',
        targetNamespace: 'default',
        cursor: undefined,
        limit: 20,
      })
    })
    expect(mockReplace).toHaveBeenCalledWith('/resource-library?keyword=docs', {
      scroll: false,
    })
  })

  it('loads more resources when the scroll trigger enters the viewport', async () => {
    mockResourceLibraryApi.listListings
      .mockResolvedValueOnce({
        items: [createListing({ id: 1, display_name: 'First batch' })],
        has_more: true,
        next_cursor: 'next-page',
        limit: 20,
      })
      .mockResolvedValueOnce({
        items: [createListing({ id: 21, display_name: 'Second batch' })],
        has_more: false,
        next_cursor: null,
        limit: 20,
      })

    render(<DiscoverResources resourceType="skill" />)

    expect(await screen.findByText('First batch')).toBeInTheDocument()
    const trigger = screen.getByTestId('resource-library-load-more-trigger')
    expect(screen.queryByTestId('resource-library-load-more')).not.toBeInTheDocument()
    act(() => {
      intersectionObserverCallback(
        [{ isIntersecting: true, target: trigger } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    expect(await screen.findByText('Second batch')).toBeInTheDocument()
    expect(screen.getByText('First batch')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
      resourceType: 'skill',
      targetNamespace: 'default',
      cursor: 'next-page',
      limit: 20,
    })
  })

  it('does not render MCP listings returned by the resource library API', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing(),
        createListing({
          id: 2,
          resource_type: 'mcp',
          name: 'mcp-server',
          display_name: 'MCP Server',
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="all" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(screen.queryByText('MCP Server')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-card-2')).not.toBeInTheDocument()
  })

  it('keeps added skills visible with a clear disabled state', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({ id: 1, display_name: 'Available Skill' }),
        createListing({ id: 2, display_name: 'Installed Skill', is_installed: true }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="skill" />)

    expect(await screen.findByText('Available Skill')).toBeInTheDocument()
    expect(screen.getByText('Installed Skill')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加 Available Skill' })).toHaveClass(
      'h-11',
      'w-11',
      'md:h-8',
      'md:w-8'
    )
    expect(screen.getByRole('button', { name: '已添加 Installed Skill' })).toBeDisabled()
  })

  it('shows skill keywords only when marketplace tags are missing', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          tags: [],
          feature_tags: ['python', 'excel'],
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="skill" />)

    const keyword = await screen.findByText('python')
    expect(keyword).toHaveAttribute('title', 'marketplace_tags.skill_keywords_fallback')
    expect(screen.getByText('excel')).toBeInTheDocument()
  })

  it('uses a system agent directly without installing it', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 81,
          resource_type: 'agent',
          name: 'wegent-chat',
          display_name: 'Wegent Chat',
          publisher_user_id: 0,
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="agent" />)

    fireEvent.click(await screen.findByRole('button', { name: '去对话 Wegent Chat' }))

    const officialFooter = screen.getByTestId('resource-listing-footer-81')
    expect(screen.getByText('Wegent 官方')).toBeInTheDocument()
    expect(officialFooter).not.toHaveTextContent('2026-05-27')
    expect(officialFooter).toHaveTextContent('4 人添加')
    expect(screen.queryByText('官方')).not.toBeInTheDocument()
    expect(mockPush).toHaveBeenCalledWith('/chat?teamId=81')
    expect(mockResourceLibraryApi.installListing).not.toHaveBeenCalled()
  })

  it.each([
    ['model', 84, 'System Model'],
    ['shell', 85, 'System Executor'],
    ['retriever', 86, 'System Retriever'],
  ] as const)(
    'does not offer installation for a directly available system %s',
    async (resourceType, id, displayName) => {
      const systemCapability = createListing({
        id,
        resource_type: resourceType,
        name: `system-${resourceType}`,
        display_name: displayName,
        publisher_user_id: 0,
        is_installed: true,
      })
      mockResourceLibraryApi.listListings.mockResolvedValue({
        items: [systemCapability],
        has_more: false,
        next_cursor: null,
        limit: 20,
      })
      mockResourceLibraryApi.getListing.mockResolvedValue(systemCapability)

      render(<DiscoverResources resourceType={resourceType} />)

      expect(await screen.findByText(displayName)).toBeVisible()
      expect(screen.queryByTestId(`install-resource-${id}-button`)).not.toBeInTheDocument()
      expect(screen.getByText('Wegent 官方')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId(`view-resource-${id}-button`))
      await screen.findByTestId('resource-detail-dialog')
      expect(screen.queryByTestId('resource-detail-install-button')).not.toBeInTheDocument()
      expect(screen.queryByText('actions.system_available')).not.toBeInTheDocument()
      expect(mockResourceLibraryApi.installListing).not.toHaveBeenCalled()
    }
  )

  it('opens a system coding agent in code mode', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 83,
          resource_type: 'agent',
          name: 'dev-team',
          display_name: 'Coding Agent',
          publisher_user_id: 0,
          bind_modes: ['code'],
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="agent" />)

    fireEvent.click(await screen.findByRole('button', { name: '去编码 Coding Agent' }))

    expect(mockPush).toHaveBeenCalledWith('/chat?agent=code&teamId=83')
    expect(mockResourceLibraryApi.installListing).not.toHaveBeenCalled()
  })

  it('shows the default destination for a multi-mode marketplace agent', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 85,
          resource_type: 'agent',
          name: 'multi-mode-agent',
          display_name: 'Multi-mode Agent',
          bind_modes: ['chat', 'code'],
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="agent" />)

    expect(await screen.findByRole('button', { name: '去对话 Multi-mode Agent' })).toBeVisible()
  })

  it('uses a marketplace agent without showing an installation success toast', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 82,
          resource_type: 'agent',
          name: 'published-agent',
          display_name: 'Published Agent',
          publisher_user_id: 3,
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })
    mockResourceLibraryApi.installListing.mockResolvedValue({
      id: 10,
      listing_id: 82,
      version_id: 10,
      user_id: 2,
      resource_type: 'agent',
      installed_kind_id: 13,
      installed_reference: {
        namespace: 'default',
        name: 'published-agent',
        team_id: 128,
      },
      install_status: 'installed',
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    render(<DiscoverResources resourceType="agent" />)

    fireEvent.click(await screen.findByRole('button', { name: '去对话 Published Agent' }))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/chat?teamId=128')
    })
    expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(82, {
      targetNamespace: 'default',
    })
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('opens an installed marketplace coding agent in code mode', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 84,
          resource_type: 'agent',
          name: 'published-code-agent',
          display_name: 'Published Code Agent',
          publisher_user_id: 3,
          bind_modes: ['code'],
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })
    mockResourceLibraryApi.installListing.mockResolvedValue({
      id: 11,
      listing_id: 84,
      version_id: 10,
      user_id: 2,
      resource_type: 'agent',
      installed_kind_id: 14,
      installed_reference: {
        namespace: 'default',
        name: 'published-code-agent',
        team_id: 129,
      },
      install_status: 'installed',
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    render(<DiscoverResources resourceType="agent" />)

    fireEvent.click(await screen.findByRole('button', { name: '去编码 Published Code Agent' }))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/chat?agent=code&teamId=129')
    })
  })

  it('does not offer globally available system agents to a group', async () => {
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [
        createListing({
          id: 81,
          resource_type: 'agent',
          name: 'wegent-chat',
          display_name: 'Wegent Chat',
          publisher_user_id: 0,
        }),
        createListing({
          id: 82,
          resource_type: 'agent',
          name: 'published-agent',
          display_name: 'Published Agent',
          publisher_user_id: 3,
        }),
      ],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })

    render(<DiscoverResources resourceType="agent" targetNamespace="platform" />)

    expect(await screen.findByText('Published Agent')).toBeInTheDocument()
    expect(screen.queryByText('Wegent Chat')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-card-81')).not.toBeInTheDocument()
  })

  it('opens listing details and installs from the drawer', async () => {
    render(<DiscoverResources resourceType="all" />)

    await screen.findByText('Doc Summary')
    fireEvent.click(screen.getByRole('button', { name: '详情 Doc Summary' }))

    const dialog = await screen.findByRole('dialog')
    expect(mockResourceLibraryApi.getListing).toHaveBeenCalledWith(1)
    expect(within(dialog).getByText('Summarizes documents')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('publisher-user')
    expect(within(dialog).queryByText('添加次数')).not.toBeInTheDocument()

    const installButton = within(dialog).getByRole('button', { name: '安装 Doc Summary' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(installButton.querySelector('svg')).not.toBeInTheDocument()
    expect(installButton).toHaveClass('h-11', 'md:h-9')
    expect(screen.getByTestId('resource-detail-actions')).toHaveClass(
      'border-t',
      'px-6',
      'py-4',
      'md:absolute',
      'md:right-12',
      'md:top-4',
      'md:border-0'
    )

    fireEvent.click(installButton)

    await waitFor(() => {
      expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(1, {
        targetNamespace: 'default',
      })
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '添加成功' })
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledTimes(2)
  })

  it('does not render zero when listing tags are empty', async () => {
    const listingWithoutTags = createListing({
      tags: [],
      feature_tags: [],
      install_count: 0,
    })
    mockResourceLibraryApi.listListings.mockResolvedValue({
      items: [listingWithoutTags],
      has_more: false,
      next_cursor: null,
      limit: 20,
    })
    mockResourceLibraryApi.getListing.mockResolvedValue(listingWithoutTags)

    render(<DiscoverResources resourceType="agent" />)

    await screen.findByText('Doc Summary')
    fireEvent.click(screen.getByRole('button', { name: '详情 Doc Summary' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('0')).not.toBeInTheDocument()
  })
})
