// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    expect(screen.getByTestId('resource-type-all-filter')).toBeInTheDocument()
    expect(screen.getByTestId('resource-type-agent-filter')).toBeInTheDocument()
    expect(screen.getByTestId('resource-type-skill-filter')).toBeInTheDocument()
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

  it('reloads discover listings when the resource type filter changes', async () => {
    render(<ResourceLibraryPage />)

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
        resourceType: 'all',
        page: 1,
        limit: 50,
      })
    })

    fireEvent.click(screen.getByTestId('resource-type-skill-filter'))

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
        resourceType: 'skill',
        page: 1,
        limit: 50,
      })
    })
  })
})
