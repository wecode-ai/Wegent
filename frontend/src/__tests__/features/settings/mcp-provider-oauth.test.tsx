// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import McpProviderIntegrations from '@/features/settings/components/McpProviderIntegrations'
import { userApis } from '@/apis/user'

const TRANSLATIONS: Record<string, string> = {
  'dingtalk.loading': 'Loading DingTalk',
  'dingtalk.save': 'Save',
  'dingtalk.saving': 'Saving',
  'dingtalk.open_link': 'Get DingTalk URL',
  'dingtalk.auth_mode_label': 'Authentication',
  'dingtalk.auth_mode_url': 'Personal StreamableHttp URL',
  'dingtalk.auth_mode_oauth': 'OAuth 2.0 authorization',
  'dingtalk.oauth_url_label': 'MCP OAuth URL',
  'dingtalk.oauth_url_hint': 'Paste the OAuth URL',
  'dingtalk.oauth_connect': 'Connect and authorize',
  'dingtalk.oauth_connecting': 'Waiting for authorization',
  'dingtalk.oauth_connected': 'Connected',
  'dingtalk.oauth_disconnect': 'Disconnect',
  'dingtalk.oauth_connect_success': 'DingTalk MCP authorized',
  'dingtalk.oauth_disconnect_success': 'DingTalk MCP authorization removed',
  'dingtalk.oauth_disconnect_failed': 'Failed to disconnect',
  'dingtalk.oauth_failed': 'DingTalk MCP authorization failed',
  'dingtalk.services.ai_table.title': 'DingTalk AI table',
}

const mockTranslate = (key: string) => TRANSLATIONS[key] || key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

const mockToast = jest.fn()
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/apis/user', () => ({
  userApis: {
    getMcpProviderServices: jest.fn(),
    getMcpProviderService: jest.fn(),
    updateMcpProviderService: jest.fn(),
    createMcpProviderOAuthSession: jest.fn(),
    pollMcpProviderOAuthSession: jest.fn(),
    disconnectMcpProviderOAuth: jest.fn(),
  },
}))

const OAUTH_URL = 'https://mcp-gw.dingtalk.com/oauth/server/aitable'

function serviceConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider_id: 'dingtalk',
    service_id: 'ai_table',
    server_name: 'dingtalk_ai_table',
    detail_url: 'https://mcp.dingtalk.com/#/detail?mcpId=9555',
    enabled: true,
    url: OAUTH_URL,
    auth_mode: 'url',
    oauth_supported: true,
    oauth_connected: false,
    oauth_expires_at: null,
    oauth_account: null,
    ...overrides,
  }
}

describe('McpProviderIntegrations OAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.open = jest.fn()
  })

  it('switches the DingTalk service to OAuth mode', async () => {
    ;(userApis.getMcpProviderServices as jest.Mock).mockResolvedValue([serviceConfig()])

    render(<McpProviderIntegrations providerId="dingtalk" />)

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth'))

    expect(screen.getByText('MCP OAuth URL')).toBeInTheDocument()
    expect(screen.getByText('Paste the OAuth URL')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeInTheDocument()
  })

  it('authorizes and reports the connected account', async () => {
    ;(userApis.getMcpProviderServices as jest.Mock).mockResolvedValue([serviceConfig()])
    ;(userApis.updateMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ auth_mode: 'oauth' })
    )
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://mcp-gw2.dingtalk.com/oauth/authorize?client_id=x',
      expires_at: Math.floor(Date.now() / 1000) + 600,
      poll_interval_seconds: 0,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      status: 'success',
      account: 'ding-user',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({
        auth_mode: 'oauth',
        oauth_connected: true,
        oauth_account: 'ding-user',
      })
    )

    render(<McpProviderIntegrations providerId="dingtalk" />)

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth')).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth'))
    fireEvent.click(screen.getByTestId('dingtalk-ai_table-oauth-connect'))

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-oauth-status')).toHaveTextContent('Connected')
    )
    expect(screen.getByTestId('dingtalk-ai_table-oauth-status')).toHaveTextContent('ding-user')
    expect(screen.getByTestId('dingtalk-ai_table-oauth-disconnect')).toBeInTheDocument()
    expect(window.open).toHaveBeenCalled()
  })
})
