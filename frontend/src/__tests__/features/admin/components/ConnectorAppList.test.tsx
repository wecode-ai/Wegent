// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import ConnectorAppList from '@/features/admin/components/ConnectorAppList'

const mockToast = jest.fn()
const mockT = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={event => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    'data-testid'?: string
  }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={event => onCheckedChange(event.currentTarget.checked)}
    />
  ),
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/alert-dialog', () => {
  // Radix closes an AlertDialog when its action is activated. Reproduce that
  // here so a two-step flow that clears its state on close is caught.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react')
  const CloseContext = React.createContext<() => void>(() => undefined)
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean
      onOpenChange?: (open: boolean) => void
      children: React.ReactNode
    }) =>
      open ? (
        <CloseContext.Provider value={() => onOpenChange?.(false)}>
          {children}
        </CloseContext.Provider>
      ) : null,
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    AlertDialogAction: ({
      children,
      onClick,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
      const close = React.useContext(CloseContext)
      return (
        <button
          {...props}
          onClick={event => {
            onClick?.(event)
            if (!event.defaultPrevented) close()
          }}
        >
          {children}
        </button>
      )
    },
  }
})

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getConnectorApps: jest.fn(),
    getUserConnectorApps: jest.fn(),
    createConnectorApp: jest.fn(),
    updateConnectorApp: jest.fn(),
    deleteConnectorApp: jest.fn(),
    discoverConnectorAppTools: jest.fn(),
    testConnectorAppTool: jest.fn(),
    createConnectorOAuthSession: jest.fn(),
    pollConnectorOAuthSession: jest.fn(),
  },
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('ConnectorAppList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getConnectorApps.mockResolvedValue([])
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([])
    mockedAdminApis.createConnectorApp.mockResolvedValue({} as never)
    mockedAdminApis.updateConnectorApp.mockResolvedValue({} as never)
    mockedAdminApis.discoverConnectorAppTools.mockResolvedValue({ tools: [] })
    mockedAdminApis.testConnectorAppTool.mockResolvedValue({
      content: [],
      structured_content: null,
      is_error: false,
    })
  })

  test('creates a public connector with policy fields', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))
    fireEvent.change(screen.getByTestId('connector-app-name'), {
      target: { value: 'Internal Docs' },
    })
    fireEvent.change(screen.getByTestId('connector-app-slug'), {
      target: { value: 'Internal-Docs' },
    })
    fireEvent.change(screen.getByTestId('connector-app-mcp-url'), {
      target: { value: 'https://mcp.example.test/docs' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[2], {
      target: { value: 'none' },
    })

    fireEvent.change(screen.getByTestId('connector-app-provider-headers'), {
      target: { value: '{"X-Tenant":"internal"}' },
    })
    fireEvent.change(screen.getByTestId('connector-app-tool-allowlist'), {
      target: { value: 'search\nread' },
    })
    fireEvent.click(screen.getByTestId('save-connector-app-button'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorApp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'internal-docs',
          auth_type: 'none',
          provider_headers: { 'X-Tenant': 'internal' },
          tool_allowlist: ['search', 'read'],
        })
      )
    })
  })

  test('defaults new apps to lazy loading and derives keywords from name and slug', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))
    fireEvent.change(screen.getByTestId('connector-app-name'), {
      target: { value: 'DingTalk AI Table' },
    })
    fireEvent.change(screen.getByTestId('connector-app-slug'), {
      target: { value: 'dingtalk_aitable' },
    })
    fireEvent.change(screen.getByTestId('connector-app-mcp-url'), {
      target: { value: 'https://mcp.example.test/aitable' },
    })

    expect((screen.getByTestId('connector-app-keywords') as HTMLTextAreaElement).value).toBe(
      'DingTalk AI Table\ndingtalk aitable'
    )
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('lazy')
    expect((screen.getAllByRole('combobox')[2] as HTMLSelectElement).value).toBe('oauth2')
    const oauthScope = screen.getByTestId('connector-app-oauth-scope') as HTMLInputElement
    expect(oauthScope.value).toBe('')
    expect(oauthScope.placeholder).toBe('')

    fireEvent.click(screen.getByTestId('save-connector-app-button'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorApp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'dingtalk_aitable',
          tool_loading_mode: 'lazy',
          auth_type: 'oauth2',
          oauth_scope: null,
          keywords: ['DingTalk AI Table', 'dingtalk aitable'],
        })
      )
    })
  })

  test('warns before switching to static loading', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'static' },
    })
    expect(screen.getByTestId('confirm-static-loading')).toBeInTheDocument()
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('lazy')

    fireEvent.click(screen.getByTestId('cancel-static-loading'))
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('lazy')

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'static' },
    })
    fireEvent.click(screen.getByTestId('confirm-static-loading'))
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('static')
  })

  test('creates an HTTP API connector with tool definitions', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))
    fireEvent.change(screen.getByTestId('connector-app-name'), {
      target: { value: 'Ticket API' },
    })
    fireEvent.change(screen.getByTestId('connector-app-slug'), {
      target: { value: 'ticket-api' },
    })
    fireEvent.change(screen.getByTestId('connector-app-mcp-url'), {
      target: { value: 'https://tickets.example.test/api' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'http' },
    })
    const definition = [
      {
        name: 'get_ticket',
        description: 'Get a ticket',
        method: 'GET',
        path: '/tickets/{id}',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        argument_locations: { id: 'path' },
        timeout_seconds: 30,
      },
    ]
    fireEvent.change(screen.getByTestId('connector-app-http-tools'), {
      target: { value: JSON.stringify(definition) },
    })
    fireEvent.click(screen.getByTestId('save-connector-app-button'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorApp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'ticket-api',
          transport: 'http',
          mcp_url: 'https://tickets.example.test/api',
          http_tools: definition,
        })
      )
    })
  })

  test('creates a connector with lazy Skill loading', async () => {
    render(<ConnectorAppList />)

    await screen.findByText('connector_apps.empty')
    fireEvent.click(screen.getByTestId('create-connector-app-button'))
    fireEvent.change(screen.getByTestId('connector-app-name'), {
      target: { value: 'DingTalk MCP Generic' },
    })
    fireEvent.change(screen.getByTestId('connector-app-slug'), {
      target: { value: 'dingtalk-mcp-generic' },
    })
    fireEvent.change(screen.getByTestId('connector-app-mcp-url'), {
      target: { value: 'https://mcp.example.test/dingtalk' },
    })
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'lazy' },
    })
    fireEvent.change(screen.getByTestId('connector-app-keywords'), {
      target: { value: '钉钉表格\nspreadsheet' },
    })
    fireEvent.click(screen.getByTestId('save-connector-app-button'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorApp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'dingtalk-mcp-generic',
          tool_loading_mode: 'lazy',
          keywords: ['钉钉表格', 'spreadsheet'],
        })
      )
    })
  })

  test('filters connector apps by name, id, description, or keyword', async () => {
    const baseApp = {
      description: '',
      icon_url: null,
      enabled: true,
      visibility: 'all' as const,
      allowed_roles: [],
      auth_type: 'oauth2' as const,
      tool_loading_mode: 'lazy' as const,
      keywords: [],
      oauth_scope: null,
      oauth_client_registered: false,
      transport: 'streamable-http' as const,
      mcp_url: 'https://mcp.example.test/app',
      provider_header_names: [],
      provider_headers_configured: false,
      forward_user_context_headers: false,
      tool_allowlist: [],
      http_tools: [],
      connection_count: 0,
      created_at: '2026-01-01T00:00:00',
      updated_at: '2026-01-01T00:00:00',
    }
    mockedAdminApis.getConnectorApps.mockResolvedValue([
      {
        ...baseApp,
        id: 11,
        slug: 'dingtalk_docs',
        name: '钉钉文档',
        keywords: ['文档'],
      },
      {
        ...baseApp,
        id: 12,
        slug: 'design-collab',
        name: 'Design Collab',
        keywords: ['figma'],
      },
    ])

    render(<ConnectorAppList />)

    await waitFor(() => expect(mockedAdminApis.getConnectorApps).toHaveBeenCalled())
    const search = screen.getByTestId('search-connector-apps')

    fireEvent.change(search, { target: { value: 'figma' } })
    expect(screen.getByTestId('connector-app-card-12')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-app-card-11')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    expect(screen.getByTestId('connector-apps-search-empty')).toBeInTheDocument()
  })

  test('requires two confirmations before hard deleting a connector app', async () => {
    mockedAdminApis.getConnectorApps.mockResolvedValueOnce([
      {
        id: 7,
        slug: 'dingtalk-mcp-generic',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        enabled: true,
        visibility: 'all',
        allowed_roles: [],
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        oauth_scope: 'mcp',
        oauth_client_registered: false,
        transport: 'streamable-http',
        mcp_url: 'https://mcp.example.test/dingtalk',
        provider_header_names: [],
        provider_headers_configured: false,
        forward_user_context_headers: false,
        tool_allowlist: [],
        http_tools: [],
        connection_count: 2,
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      },
    ])
    mockedAdminApis.getConnectorApps.mockResolvedValueOnce([])
    mockedAdminApis.deleteConnectorApp.mockResolvedValue(undefined as never)

    render(<ConnectorAppList />)

    await waitFor(() => expect(mockedAdminApis.getConnectorApps).toHaveBeenCalled())
    fireEvent.click(await screen.findByTestId('delete-connector-app-7'))

    fireEvent.click(screen.getByTestId('acknowledge-delete-app'))
    expect(mockedAdminApis.deleteConnectorApp).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-delete-app'))

    await waitFor(() => {
      expect(mockedAdminApis.deleteConnectorApp).toHaveBeenCalledWith(7)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('connector-app-card-7')).not.toBeInTheDocument()
    })
  })

  test('discovers an MCP tool before testing when no allowlist is configured', async () => {
    mockedAdminApis.getConnectorApps.mockResolvedValue([
      {
        id: 8,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        enabled: true,
        visibility: 'all',
        allowed_roles: [],
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        oauth_scope: 'mcp',
        oauth_client_registered: true,
        transport: 'streamable-http',
        mcp_url: 'https://mcp.example.test/design',
        provider_header_names: [],
        provider_headers_configured: false,
        forward_user_context_headers: false,
        tool_allowlist: [],
        http_tools: [],
        connection_count: 0,
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      },
    ])
    mockedAdminApis.discoverConnectorAppTools.mockResolvedValue({
      tools: [
        {
          name: 'design-collab__search',
          title: 'Search',
          description: 'Search designs',
          input_schema: { type: 'object', properties: {} },
          connector_id: 'design-collab',
          raw_tool_name: 'search',
          model_visible: true,
          risk_hints: {},
          source_transport: 'streamable-http',
        },
      ],
    })

    render(<ConnectorAppList />)

    fireEvent.click(await screen.findByTestId('test-connector-app-tool-8'))

    await waitFor(() => {
      expect(mockedAdminApis.discoverConnectorAppTools).toHaveBeenCalledWith(8)
      expect(mockedAdminApis.testConnectorAppTool).toHaveBeenCalledWith(8, 'search')
    })
  })

  test('shows the tool error returned by the MCP server', async () => {
    mockedAdminApis.getConnectorApps.mockResolvedValue([
      {
        id: 10,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        enabled: true,
        visibility: 'all',
        allowed_roles: [],
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        oauth_scope: 'mcp',
        oauth_client_registered: true,
        transport: 'streamable-http',
        mcp_url: 'https://mcp.example.test/design',
        provider_header_names: [],
        provider_headers_configured: false,
        forward_user_context_headers: false,
        tool_allowlist: ['search'],
        http_tools: [],
        connection_count: 0,
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      },
    ])
    mockedAdminApis.testConnectorAppTool.mockResolvedValue({
      is_error: true,
      content: [{ type: 'text', text: 'query is required' }],
      structured_content: null,
    })

    render(<ConnectorAppList />)

    fireEvent.click(await screen.findByTestId('test-connector-app-tool-10'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'connector_apps.errors.test_returned_error',
          description: 'query is required',
        })
      )
    })
  })

  test('opens OAuth authorization for a disconnected OAuth connector', async () => {
    mockedAdminApis.getConnectorApps.mockResolvedValue([
      {
        id: 9,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        enabled: true,
        visibility: 'all',
        allowed_roles: [],
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        oauth_scope: 'mcp',
        oauth_client_registered: true,
        transport: 'streamable-http',
        mcp_url: 'https://mcp.example.test/design',
        provider_header_names: [],
        provider_headers_configured: false,
        forward_user_context_headers: false,
        tool_allowlist: [],
        http_tools: [],
        connection_count: 0,
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      },
    ])
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      {
        id: 1,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        connection: { status: 'disconnected' },
      },
    ])
    mockedAdminApis.createConnectorOAuthSession.mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://oauth.example.test/authorize',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      poll_interval_seconds: 0,
    })
    mockedAdminApis.pollConnectorOAuthSession.mockResolvedValue({
      status: 'success',
      connection: { status: 'connected' },
    })
    const replace = jest.fn()
    const popup = { closed: false, opener: null, location: { replace } } as unknown as Window
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup)

    render(<ConnectorAppList />)

    fireEvent.click(await screen.findByTestId('authorize-connector-app-9'))

    await waitFor(() => {
      expect(mockedAdminApis.createConnectorOAuthSession).toHaveBeenCalledWith('design-collab')
      expect(openSpy).toHaveBeenCalledWith('/mcp-oauth-pending.html', '_blank')
      expect(replace).toHaveBeenCalledWith('https://oauth.example.test/authorize')
      expect(mockedAdminApis.pollConnectorOAuthSession).toHaveBeenCalledWith(
        'session-1',
        'poll-token'
      )
    })
    openSpy.mockRestore()
  })

  test('hides the authorize action while connection status is unknown', async () => {
    mockedAdminApis.getConnectorApps.mockResolvedValue([
      {
        id: 9,
        slug: 'design-collab',
        name: 'Design Collab',
        description: '',
        icon_url: null,
        enabled: true,
        visibility: 'all',
        allowed_roles: [],
        auth_type: 'oauth2',
        tool_loading_mode: 'static',
        keywords: [],
        oauth_scope: 'mcp',
        oauth_client_registered: true,
        transport: 'streamable-http',
        mcp_url: 'https://mcp.example.test/design',
        provider_header_names: [],
        provider_headers_configured: false,
        forward_user_context_headers: false,
        tool_allowlist: [],
        http_tools: [],
        connection_count: 0,
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      },
    ])
    mockedAdminApis.getUserConnectorApps.mockRejectedValue(new Error('projection unavailable'))

    render(<ConnectorAppList />)

    expect(await screen.findByText('Design Collab')).toBeInTheDocument()
    expect(screen.queryByTestId('authorize-connector-app-9')).not.toBeInTheDocument()
  })
})
