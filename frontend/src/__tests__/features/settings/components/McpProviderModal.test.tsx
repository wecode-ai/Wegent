// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mcpProviderApis } from '@/apis/mcpProviders'
import { McpProviderBrowser } from '@/features/settings/components/McpProviderModal'

const mockToast = jest.fn()
const mockT = (key: string) => key

jest.mock('@/apis/mcpProviders', () => ({
  mcpProviderApis: {
    getProviders: jest.fn(),
    syncServers: jest.fn(),
    updateKeys: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

const mockedApis = mcpProviderApis as jest.Mocked<typeof mcpProviderApis>

describe('McpProviderBrowser', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedApis.getProviders.mockResolvedValue({
      providers: [
        {
          key: 'community',
          name: 'Community MCP',
          description: '',
          discover_url: '',
          api_key_url: '',
          token_field_name: 'community_mcp',
          has_token: true,
          requires_token: false,
        },
      ],
    })
    mockedApis.syncServers.mockResolvedValue({
      success: true,
      message: 'ok',
      servers: [
        {
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          is_active: true,
          provider: 'Community MCP',
        },
        {
          id: '@community/report',
          name: '数据报告',
          description: '生成分析报告',
          type: 'streamable-http',
          is_active: true,
          provider: 'Community MCP',
          tags: ['分析'],
        },
      ],
    })
  })

  it('filters the loaded provider list locally', async () => {
    const user = userEvent.setup()
    render(<McpProviderBrowser onImportServer={jest.fn()} />)

    expect(await screen.findByText('Content Search')).toBeInTheDocument()
    expect(screen.getByText('数据报告')).toBeInTheDocument()

    await user.type(screen.getByTestId('mcp-provider-search-input'), '分析')

    expect(screen.queryByText('Content Search')).not.toBeInTheDocument()
    expect(screen.getByText('数据报告')).toBeInTheDocument()
    expect(mockedApis.syncServers).toHaveBeenCalledTimes(1)
  })
})
