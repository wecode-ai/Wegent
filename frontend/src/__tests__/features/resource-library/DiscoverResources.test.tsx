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
const mockPush = jest.fn()
const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()

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
        'actions.use': '去使用',
        'actions.add': '添加',
        'actions.added': '已添加',
        'actions.installed': '已安装',
        'actions.details': '详情',
        'actions.retry': '重试',
        'actions.search': '搜索',
        'fields.sort': '排序',
        'fields.install_count': '安装次数',
        'fields.publisher': '发布者',
        'fields.official_publisher': 'Wegent 官方',
        'fields.updated_at': '更新时间',
        'search.placeholder': '搜索资源',
        'sort.default': '默认',
        'sort.popular': '热门',
        'sort.latest': '最新',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
        'messages.install_success': '安装成功',
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
      'min-h-[180px]',
      'p-4',
      'gap-4',
      'rounded-xl'
    )
    const actionButton = screen.getByRole('button', { name: '添加 Doc Summary' })
    expect(actionButton).toBeEnabled()
    expect(actionButton).toHaveClass(
      'h-11',
      'w-11',
      'border-0',
      'bg-muted',
      'p-0',
      'md:h-9',
      'md:w-9'
    )
    expect(actionButton).not.toHaveClass('md:opacity-0', 'md:pointer-events-none')
    expect(actionButton.querySelector('svg')).toBeInTheDocument()
    const footer = screen.getByTestId('resource-listing-footer-1')
    expect(footer).toHaveClass('mt-auto')
    expect(footer).toHaveTextContent('publisher-user')
    expect(footer).toHaveTextContent('2026-05-27')
    expect(within(footer).getByRole('time')).toHaveAttribute('datetime', '2026-05-27T00:00:00')
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
    expect(footer).not.toHaveTextContent('publisher-user')
    expect(footer).not.toHaveTextContent('#3')
    expect(within(footer).getByRole('time')).toBeInTheDocument()
  })

  it('uses the same four-column desktop grid for other resource types', async () => {
    render(<DiscoverResources resourceType="agent" />)

    expect(await screen.findByTestId('discover-resource-grid')).toHaveClass(
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    expect(screen.getByTestId('resource-listing-card-1')).toHaveClass('min-h-[160px]')
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
    expect(screen.getByTestId('resource-library-search-input')).toBeInTheDocument()
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

  it('loads more resources from the discovery cursor', async () => {
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
    fireEvent.click(screen.getByTestId('resource-library-load-more'))

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

  it('does not render skills already installed for the current user', async () => {
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
    expect(screen.queryByText('Installed Skill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-card-2')).not.toBeInTheDocument()
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

    fireEvent.click(await screen.findByRole('button', { name: '去使用 Wegent Chat' }))

    expect(screen.getByTestId('resource-listing-footer-81')).toHaveTextContent(
      'Wegent 官方2026-05-27'
    )
    expect(mockPush).toHaveBeenCalledWith('/chat?teamId=81')
    expect(mockResourceLibraryApi.installListing).not.toHaveBeenCalled()
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

    fireEvent.click(await screen.findByRole('button', { name: '去使用 Published Agent' }))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/chat?teamId=128')
    })
    expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(82, {
      targetNamespace: 'default',
    })
    expect(mockToast).not.toHaveBeenCalled()
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
    expect(within(dialog).queryByText('安装次数')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '添加 Doc Summary' }))

    await waitFor(() => {
      expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(1, {
        targetNamespace: 'default',
      })
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '安装成功' })
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledTimes(2)
  })
})
