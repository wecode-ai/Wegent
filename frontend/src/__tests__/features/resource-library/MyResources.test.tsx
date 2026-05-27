// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { MyResources } from '@/features/resource-library/components/MyResources'
import type {
  ResourceLibraryInstall,
  ResourceLibraryListing,
} from '@/features/resource-library/types'

const mockToast = jest.fn()

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listMyInstalls: jest.fn(),
    listMyPublished: jest.fn(),
    getListing: jest.fn(),
    installListing: jest.fn(),
    createListing: jest.fn(),
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

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'tabs.installed': '已安装',
        'tabs.published': '我发布的',
        'filters.agent': '智能体',
        'filters.skill': 'Skill',
        'filters.mcp': 'MCP',
        'actions.install': '安装',
        'actions.installed': '已安装',
        'actions.details': '详情',
        'actions.publish': '发布资源',
        'actions.cancel': '取消',
        'actions.close': '关闭',
        'fields.name': '名称',
        'fields.display_name': '显示名称',
        'fields.description': '描述',
        'fields.tags': '标签',
        'fields.source_id': '源资源 ID',
        'fields.type': '资源类型',
        'fields.version': '版本',
        'fields.install_count': '安装次数',
        'fields.publisher': '发布者',
        'fields.updated_at': '更新时间',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
        'messages.publish_success': '发布成功',
        'messages.install_success': '安装成功',
        'messages.install_failed': '安装失败',
        'publish.description': '发布已有资源',
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
    is_installed: true,
    created_at: '2026-05-27T00:00:00',
    updated_at: '2026-05-27T00:00:00',
    ...overrides,
  }
}

function createInstall(listing: ResourceLibraryListing): ResourceLibraryInstall {
  return {
    id: 11,
    listing_id: listing.id,
    version_id: listing.current_version_id ?? 10,
    user_id: 2,
    resource_type: listing.resource_type,
    listing,
    installed_kind_id: 20,
    installed_reference: { namespace: 'default', name: listing.name },
    install_status: 'installed',
    requires_configuration: false,
    installed_at: '2026-05-27T00:00:00',
    updated_at: '2026-05-27T00:00:00',
  }
}

describe('MyResources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResourceLibraryApi.listMyInstalls.mockResolvedValue({
      items: [createInstall(createListing())],
      total: 1,
    })
    mockResourceLibraryApi.listMyPublished.mockResolvedValue({
      items: [createListing({ id: 2, name: 'research-agent', display_name: 'Research Agent' })],
      total: 1,
    })
    mockResourceLibraryApi.createListing.mockResolvedValue(
      createListing({ id: 3, name: 'new-agent', display_name: 'New Agent' })
    )
    mockResourceLibraryApi.getListing.mockResolvedValue(createListing())
    mockResourceLibraryApi.installListing.mockResolvedValue(createInstall(createListing()))
  })

  it('loads installed resources by default and switches to published resources', async () => {
    render(<MyResources resourceType="skill" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listMyInstalls).toHaveBeenCalledWith({
      resourceType: 'skill',
      page: 1,
      limit: 50,
    })

    fireEvent.click(screen.getByRole('button', { name: '我发布的' }))

    expect(await screen.findByText('Research Agent')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listMyPublished).toHaveBeenCalledWith({
      resourceType: 'skill',
      page: 1,
      limit: 50,
    })
  })

  it('publishes a resource from the dialog', async () => {
    render(<MyResources resourceType="agent" />)

    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发布资源' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('源资源 ID'), { target: { value: '42' } })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'new-agent' } })
    fireEvent.change(within(dialog).getByLabelText('显示名称'), { target: { value: 'New Agent' } })
    fireEvent.change(within(dialog).getByLabelText('描述'), {
      target: { value: 'Handles research' },
    })
    fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: 'research,agent' } })
    fireEvent.change(within(dialog).getByLabelText('版本'), { target: { value: '1.0.0' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发布资源' }))

    await waitFor(() => {
      expect(mockResourceLibraryApi.createListing).toHaveBeenCalledWith({
        resource_type: 'agent',
        source_id: 42,
        name: 'new-agent',
        display_name: 'New Agent',
        description: 'Handles research',
        icon: null,
        tags: ['research', 'agent'],
        version: '1.0.0',
        manifest_options: {},
      })
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '发布成功' })
  })
})
