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
        'filters.skill': 'Skill',
        'filters.mcp': 'MCP',
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

  it('renders the resource library shell and switches tabs', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(await screen.findByText('暂无资源')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发现' })).toBeInTheDocument()

    const mineTab = screen.getByRole('button', { name: '我的' })
    expect(mineTab).toBeInTheDocument()

    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()

    fireEvent.click(mineTab)

    expect(mineTab).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
    expect(await screen.findByTestId('my-resources')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockResourceLibraryApi.listMyInstalls).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.queryByLabelText('正在加载资源')).not.toBeInTheDocument()
    })
  })
})
