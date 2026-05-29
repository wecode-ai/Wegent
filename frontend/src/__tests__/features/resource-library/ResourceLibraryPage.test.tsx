// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'

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
        'tabs.installed': '已安装',
        'tabs.published': '我发布的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
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

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

describe('ResourceLibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders my resources as the only visible resource library view', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.queryByRole('heading', { name: '资源库' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发现' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '我的' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'MCP' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
    expect(await screen.findByTestId('my-resource-management')).toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).not.toHaveBeenCalled()
    expect(mockResourceLibraryApi.listMyInstalls).not.toHaveBeenCalled()
  })
})
