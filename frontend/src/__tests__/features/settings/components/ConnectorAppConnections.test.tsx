// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import ConnectorAppConnections from '@/features/settings/components/ConnectorAppConnections'

const mockToast = jest.fn()
const mockT = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getUserConnectorApps: jest.fn(),
    createConnectorOAuthSession: jest.fn(),
    pollConnectorOAuthSession: jest.fn(),
    disconnectConnectorApp: jest.fn(),
    refreshConnectorApp: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

const baseApp = {
  id: 1,
  slug: 'dingtalk-mcp-generic',
  name: 'DingTalk MCP Generic',
  description: 'DingTalk docs',
  icon_url: null,
  auth_type: 'oauth2' as const,
  tool_loading_mode: 'static' as const,
}

describe('ConnectorAppConnections', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows an authorize button for a disconnected OAuth app', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      { ...baseApp, connection: { status: 'disconnected' } },
    ])

    render(<ConnectorAppConnections />)

    expect(
      await screen.findByTestId('authorize-connector-app-dingtalk-mcp-generic')
    ).toBeInTheDocument()
    expect(screen.getByText('common:integrations.connector_apps.status.disconnected'))
  })

  it('filters apps by name, slug, or keyword', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        id: 1,
        slug: 'dingtalk_docs',
        name: '钉钉文档',
        description: '',
        keywords: ['文档'],
        connection: { status: 'disconnected' },
      },
      {
        ...baseApp,
        id: 2,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        keywords: ['figma'],
        connection: { status: 'connected' },
      },
    ])

    render(<ConnectorAppConnections />)

    await screen.findByText('钉钉文档')
    const search = screen.getByTestId('search-connector-app-connections')

    fireEvent.change(search, { target: { value: 'figma' } })
    expect(screen.getByText('Design Collab')).toBeInTheDocument()
    expect(screen.queryByText('钉钉文档')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    expect(screen.getByTestId('connector-app-connections-search-empty')).toBeInTheDocument()
  })

  it('lists authorized apps before apps that still need authorization', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        id: 1,
        slug: 'pending-one',
        name: 'Pending One',
        connection: { status: 'disconnected' },
      },
      {
        ...baseApp,
        id: 2,
        slug: 'connected-one',
        name: 'Connected One',
        connection: { status: 'connected' },
      },
      {
        ...baseApp,
        id: 3,
        slug: 'expired-one',
        name: 'Expired One',
        connection: { status: 'expired' },
      },
    ])

    render(<ConnectorAppConnections />)

    await screen.findByText('Connected One')
    const rendered = screen
      .getAllByTestId(/^connector-app-connection-/)
      .map(node => node.getAttribute('data-testid'))

    expect(rendered).toEqual([
      'connector-app-connection-connected-one',
      'connector-app-connection-pending-one',
      'connector-app-connection-expired-one',
    ])
  })

  it('always lists the four built-in DingTalk apps first', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        id: 10,
        slug: 'connected-other',
        name: 'Connected Other',
        connection: { status: 'connected' },
      },
      {
        ...baseApp,
        id: 11,
        slug: 'dingtalk_wiki',
        name: 'DingTalk Wiki',
        connection: { status: 'expired' },
      },
      {
        ...baseApp,
        id: 12,
        slug: 'dingtalk_docs',
        name: 'DingTalk Docs',
        connection: { status: 'disconnected' },
      },
      {
        ...baseApp,
        id: 13,
        slug: 'dingtalk_aitable',
        name: 'DingTalk AI Table',
        connection: { status: 'connected' },
      },
      {
        ...baseApp,
        id: 14,
        slug: 'dingtalk_sheet',
        name: 'DingTalk Sheet',
        connection: { status: 'disconnected' },
      },
      {
        ...baseApp,
        id: 15,
        slug: 'expired-other',
        name: 'Expired Other',
        connection: { status: 'expired' },
      },
    ])

    render(<ConnectorAppConnections />)

    await screen.findByText('DingTalk Docs')
    const rendered = screen
      .getAllByTestId(/^connector-app-connection-/)
      .map(node => node.getAttribute('data-testid'))

    expect(rendered).toEqual([
      'connector-app-connection-dingtalk_docs',
      'connector-app-connection-dingtalk_sheet',
      'connector-app-connection-dingtalk_aitable',
      'connector-app-connection-dingtalk_wiki',
      'connector-app-connection-connected-other',
      'connector-app-connection-expired-other',
    ])
  })

  it('hides the authorize button once connected and shows the account', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        connection: { status: 'connected', external_account_name: 'chenbo' },
      },
    ])

    render(<ConnectorAppConnections />)

    expect(await screen.findByText('DingTalk MCP Generic')).toBeInTheDocument()
    expect(
      screen.queryByTestId('authorize-connector-app-dingtalk-mcp-generic')
    ).not.toBeInTheDocument()
  })

  it('disconnects an authorized app after confirmation', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      { ...baseApp, connection: { status: 'connected' } },
    ])
    mockedAdminApis.disconnectConnectorApp.mockResolvedValue(undefined)

    render(<ConnectorAppConnections />)
    fireEvent.click(await screen.findByTestId('disconnect-connector-app-dingtalk-mcp-generic'))
    fireEvent.click(await screen.findByTestId('confirm-disconnect-connector'))

    await waitFor(() =>
      expect(mockedAdminApis.disconnectConnectorApp).toHaveBeenCalledWith('dingtalk-mcp-generic')
    )
    expect(mockToast).toHaveBeenCalledWith({
      title: 'common:integrations.connector_apps.disconnected',
    })
  })

  it('explains an upstream failure and offers a retry', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        connection: { status: 'connected', last_error: 'upstream 502' },
      },
    ])
    mockedAdminApis.refreshConnectorApp.mockResolvedValue({
      status: 'connected',
      last_error: 'upstream 502',
    })

    render(<ConnectorAppConnections />)

    expect(
      await screen.findByText('common:integrations.connector_apps.upstream_error')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('retry-connector-app-dingtalk-mcp-generic'))

    await waitFor(() =>
      expect(mockedAdminApis.refreshConnectorApp).toHaveBeenCalledWith('dingtalk-mcp-generic')
    )
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'common:integrations.connector_apps.retry_failed',
        description: 'upstream 502',
      })
    )
  })

  it('reports recovery only when the upstream probe succeeds', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        connection: { status: 'connected', last_error: 'upstream 502' },
      },
    ])
    mockedAdminApis.refreshConnectorApp.mockResolvedValue({
      status: 'connected',
      last_error: null,
    })

    render(<ConnectorAppConnections />)

    fireEvent.click(await screen.findByTestId('retry-connector-app-dingtalk-mcp-generic'))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        variant: undefined,
        title: 'common:integrations.connector_apps.retry_succeeded',
        description: undefined,
      })
    )
  })

  it('completes the OAuth flow and reloads apps', async () => {
    mockedAdminApis.getUserConnectorApps
      .mockResolvedValueOnce([{ ...baseApp, connection: { status: 'disconnected' } }])
      .mockResolvedValueOnce([{ ...baseApp, connection: { status: 'connected' } }])
    mockedAdminApis.createConnectorOAuthSession.mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://oauth.example.test/authorize',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      poll_interval_seconds: 0,
    })
    mockedAdminApis.pollConnectorOAuthSession.mockResolvedValue({ status: 'success' })
    const replace = jest.fn()
    const popup = { closed: false, opener: null, location: { replace } } as unknown as Window
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup)

    render(<ConnectorAppConnections />)
    fireEvent.click(await screen.findByTestId('authorize-connector-app-dingtalk-mcp-generic'))

    await waitFor(() =>
      expect(mockedAdminApis.pollConnectorOAuthSession).toHaveBeenCalledWith(
        'session-1',
        'poll-token'
      )
    )
    await waitFor(() => expect(mockedAdminApis.getUserConnectorApps).toHaveBeenCalledTimes(2))
    expect(openSpy).toHaveBeenCalledWith('/mcp-oauth-pending.html', '_blank')
    expect(replace).toHaveBeenCalledWith('https://oauth.example.test/authorize')
    openSpy.mockRestore()
  })
})
