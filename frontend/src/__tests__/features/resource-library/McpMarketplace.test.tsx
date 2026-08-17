// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mcpProviderApis, type MCPServer } from '@/apis/mcpProviders'
import { McpMarketplace } from '@/features/resource-library/components/McpMarketplace'

let mockTargetServer: MCPServer | null = null
const mockT = (key: string) => key

jest.mock('@/apis/mcpProviders', () => ({
  mcpProviderApis: {
    getProviders: jest.fn(),
    syncServers: jest.fn(),
    updateKeys: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('@/features/resource-library/components/McpTargetSelectorDialog', () => ({
  McpTargetSelectorDialog: ({ server, open }: { server: MCPServer | null; open: boolean }) => {
    mockTargetServer = server
    return open ? <div data-testid="mcp-target-selector">{server?.name}</div> : null
  },
}))

const mockedApis = mcpProviderApis as jest.Mocked<typeof mcpProviderApis>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('McpMarketplace', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTargetServer = null
    mockedApis.getProviders.mockResolvedValue({
      providers: [
        {
          key: 'community',
          name: 'Community MCP',
          description: '',
          discover_url: 'https://mcp.example.com/servers',
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
    mockedApis.syncServers.mockResolvedValue({
      success: true,
      message: 'ok',
      servers: [
        {
          id: '@community/search',
          name: 'Content Search',
          description: 'Search community content',
          type: 'streamable-http',
          base_url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer token' },
          is_active: true,
          provider: 'Community MCP',
          tags: null,
          installState: 'not_installed',
        },
        {
          id: '@community/report',
          name: '数据报告',
          description: '生成分析报告',
          type: 'streamable-http',
          base_url: 'https://example.test/report',
          is_active: true,
          provider: 'Community MCP',
          tags: ['分析'],
          installState: 'not_installed',
        },
      ],
    })
    mockedApis.updateKeys.mockResolvedValue({
      success: true,
      message: 'ok',
    })
  })

  it('loads all MCPs and filters them locally', async () => {
    const user = userEvent.setup()
    render(<McpMarketplace />)

    expect(await screen.findByText('Content Search')).toBeInTheDocument()
    expect(screen.getByText('数据报告')).toBeInTheDocument()
    expect(mockedApis.syncServers).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('HTTP')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-marketplace-card-@community/search')).not.toHaveClass(
      'min-h-[180px]'
    )
    expect(screen.getByTestId('mcp-marketplace-provider-community')).toHaveClass(
      'min-h-11',
      'md:min-h-9'
    )
    expect(screen.getByTestId('mcp-marketplace-open-community')).toHaveAttribute(
      'href',
      'https://mcp.example.com/servers'
    )

    await user.type(screen.getByTestId('mcp-marketplace-search-input'), '分析')

    expect(screen.queryByText('Content Search')).not.toBeInTheDocument()
    expect(screen.getByText('数据报告')).toBeInTheDocument()
    expect(mockedApis.syncServers).toHaveBeenCalledTimes(1)
  })

  it('opens target selection instead of installing the MCP to the user', async () => {
    const user = userEvent.setup()
    render(<McpMarketplace />)

    await user.click(await screen.findByTestId('add-market-mcp-@community/search'))

    expect(screen.getByTestId('mcp-target-selector')).toHaveTextContent('Content Search')
    expect(mockTargetServer?.id).toBe('@community/search')
  })

  it('ignores a stale response after switching providers', async () => {
    const user = userEvent.setup()
    const communityResponse = deferred<Awaited<ReturnType<typeof mcpProviderApis.syncServers>>>()
    const partnerResponse = deferred<Awaited<ReturnType<typeof mcpProviderApis.syncServers>>>()
    mockedApis.syncServers.mockImplementation(providerKey =>
      providerKey === 'community' ? communityResponse.promise : partnerResponse.promise
    )

    render(<McpMarketplace />)

    await user.click(await screen.findByTestId('mcp-marketplace-provider-partner'))
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
    expect(await screen.findByTestId('mcp-marketplace-card-partner-server')).toBeInTheDocument()

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

    expect(screen.getByTestId('mcp-marketplace-card-partner-server')).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-marketplace-card-community-server')).not.toBeInTheDocument()
  })

  it('guides users to configure a required API key before loading MCPs', async () => {
    const user = userEvent.setup()
    mockedApis.getProviders.mockResolvedValue({
      providers: [
        {
          key: 'mcp_router',
          name: 'MCP Router',
          description: '',
          discover_url: 'https://mcprouter.co',
          api_key_url: 'https://mcprouter.co/settings/keys',
          token_field_name: 'mcp_router',
          has_token: false,
          requires_token: true,
        },
      ],
    })

    render(<McpMarketplace />)

    expect(await screen.findByTestId('mcp-marketplace-api-key-required')).toBeInTheDocument()
    expect(mockedApis.syncServers).not.toHaveBeenCalled()
    expect(screen.getByTestId('mcp-marketplace-get-api-key-mcp_router')).toHaveAttribute(
      'href',
      'https://mcprouter.co/settings/keys'
    )

    await user.type(screen.getByTestId('mcp-marketplace-api-key-input'), 'router-key')
    await user.click(screen.getByTestId('mcp-marketplace-save-api-key'))

    await waitFor(() => {
      expect(mockedApis.updateKeys).toHaveBeenCalledWith({ mcp_router: 'router-key' })
      expect(mockedApis.syncServers).toHaveBeenCalledWith('mcp_router')
    })
  })
})
