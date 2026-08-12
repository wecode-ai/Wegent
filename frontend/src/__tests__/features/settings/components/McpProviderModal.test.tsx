// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

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

  it('ignores a stale response after switching providers', async () => {
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
        {
          key: 'partner',
          name: 'Partner MCP',
          description: '',
          discover_url: '',
          api_key_url: '',
          token_field_name: 'partner_mcp',
          has_token: true,
          requires_token: false,
        },
      ],
    })
    const communityResponse = deferred<Awaited<ReturnType<typeof mcpProviderApis.syncServers>>>()
    const partnerResponse = deferred<Awaited<ReturnType<typeof mcpProviderApis.syncServers>>>()
    mockedApis.syncServers.mockImplementation(providerKey =>
      providerKey === 'community' ? communityResponse.promise : partnerResponse.promise
    )

    render(<McpProviderBrowser onImportServer={jest.fn()} />)

    fireEvent.click(await screen.findByTestId('mcp-provider-option-partner'))
    await act(async () => {
      partnerResponse.resolve({
        success: true,
        message: 'ok',
        servers: [
          {
            id: 'partner-server',
            name: 'Partner Server',
            description: '',
            type: 'streamable-http',
            is_active: true,
            provider: 'Partner MCP',
          },
        ],
      })
    })
    expect(await screen.findByText('Partner Server')).toBeInTheDocument()

    await act(async () => {
      communityResponse.resolve({
        success: true,
        message: 'ok',
        servers: [
          {
            id: 'community-server',
            name: 'Community Server',
            description: '',
            type: 'streamable-http',
            is_active: true,
            provider: 'Community MCP',
          },
        ],
      })
    })

    expect(screen.getByText('Partner Server')).toBeInTheDocument()
    expect(screen.queryByText('Community Server')).not.toBeInTheDocument()
  })
})
