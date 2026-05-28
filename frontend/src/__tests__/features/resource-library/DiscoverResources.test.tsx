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
        'actions.installed': '已安装',
        'actions.details': '详情',
        'actions.retry': '重试',
        'actions.search': '搜索',
        'fields.install_count': '安装次数',
        'fields.publisher': '发布者',
        'fields.updated_at': '更新时间',
        'search.placeholder': '搜索资源',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
        'messages.install_success': '安装成功',
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

  it('loads discover listings for the selected resource type', async () => {
    render(<DiscoverResources resourceType="skill" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
      resourceType: 'skill',
      page: 1,
      limit: 50,
    })
    expect(screen.getByTestId('resource-listing-card-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装 Doc Summary' })).toBeEnabled()
  })

  it('renders custom toolbar controls beside discover search', async () => {
    render(
      <DiscoverResources
        resourceType="all"
        toolbarStart={<div data-testid="resource-filter-slot">资源类型筛选</div>}
      />
    )

    const toolbar = screen.getByTestId('discover-resources-toolbar')
    expect(within(toolbar).getByTestId('resource-filter-slot')).toBeInTheDocument()
    expect(within(toolbar).getByTestId('resource-library-search-input')).toBeInTheDocument()
    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
  })

  it('keeps desktop search controls aligned to the right side of the toolbar', async () => {
    render(
      <DiscoverResources
        resourceType="all"
        toolbarStart={<div data-testid="resource-filter-slot">资源类型筛选</div>}
      />
    )

    const searchInput = screen.getByTestId('resource-library-search-input')
    const searchControls = searchInput.closest('div')
    const toolbar = screen.getByTestId('discover-resources-toolbar')

    expect(toolbar).toHaveClass('w-full')
    expect(toolbar).toHaveClass('md:flex-row')
    expect(toolbar).toHaveClass('md:justify-between')
    expect(searchControls).toHaveClass('md:ml-auto')
    expect(searchControls).toHaveClass('md:flex-none')
    expect(searchControls).toHaveClass('md:max-w-xl')
    expect(searchControls).not.toHaveClass('lg:flex-1')
    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
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
      total: 2,
    })

    render(<DiscoverResources resourceType="all" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(screen.queryByText('MCP Server')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resource-listing-card-2')).not.toBeInTheDocument()
  })

  it('opens listing details and installs from the drawer', async () => {
    render(<DiscoverResources resourceType="all" />)

    await screen.findByText('Doc Summary')
    fireEvent.click(screen.getByRole('button', { name: '详情 Doc Summary' }))

    const dialog = await screen.findByRole('dialog')
    expect(mockResourceLibraryApi.getListing).toHaveBeenCalledWith(1)
    expect(within(dialog).getByText('Summarizes documents')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '安装 Doc Summary' }))

    await waitFor(() => {
      expect(mockResourceLibraryApi.installListing).toHaveBeenCalledWith(1, {
        targetNamespace: 'default',
      })
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '安装成功' })
    expect(mockResourceLibraryApi.listListings).toHaveBeenCalledTimes(2)
  })
})
