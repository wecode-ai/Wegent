// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { userApis } from '@/apis/user'
import { McpProviderConfigDialog } from '@/features/settings/components/McpProviderConfigDialog'

const TRANSLATIONS: Record<string, string> = {
  'dingtalk.auth_mode_oauth': 'OAuth 2.0 authorization',
  'dingtalk.auth_mode_url': 'API Key / StreamableHttp URL',
  'dingtalk.oauth_connected': 'Connected',
  'dingtalk.oauth_connect': 'Connect and authorize',
  'dingtalk.oauth_connecting': 'Waiting for authorization',
  'dingtalk.oauth_connect_success': 'DingTalk MCP authorized',
  'dingtalk.oauth_failed': 'DingTalk MCP authorization failed',
  'dingtalk.oauth_restore_failed': 'Failed to restore the previous configuration',
  'dingtalk.oauth_url_label': 'MCP OAuth URL',
  'dingtalk.oauth_url_placeholder': 'Paste the OAuth 2.0 authorization URL',
  'dingtalk.url_label': 'MCP URL',
  'dingtalk.url_placeholder': 'Paste the StreamableHttp URL here',
  'dingtalk.modal.step_open_home': 'Open the service MCP page',
  'dingtalk.modal.step_get_config': 'Click "View MCP Server Config"',
  'dingtalk.modal.step_copy_oauth_url': 'Copy the "MCP OAuth URL" on the "OAuth 2.0" tab',
  'dingtalk.modal.step_copy_url': 'Switch to the "API Key" tab and copy the StreamableHttp URL',
  'dingtalk.modal.step_paste_oauth_url': 'Paste the URL into "MCP OAuth URL" below',
  'dingtalk.modal.step_paste_url': 'Paste the URL into "MCP URL" below',
  'dingtalk.modal.step_connect_oauth':
    'Click "Connect and authorize" to complete DingTalk authorization',
  'dingtalk.modal.step_save_oauth': 'After authorization succeeds, click "Save and Enable"',
  'dingtalk.modal.step_save_url': 'Click "Save and Enable"',
  'dingtalk.modal.save': 'Save and Enable',
  'dingtalk.modal.save_success': 'Saved and enabled',
  'dingtalk.saving': 'Saving',
  'dingtalk.services.ai_table.default_name': 'DingTalk AI Table',
}

const mockT = (key: string) => TRANSLATIONS[key] || key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

const mockToast = jest.fn()
jest.spyOn(console, 'error').mockImplementation(() => undefined)
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/apis/user', () => ({
  userApis: {
    getMcpProviderService: jest.fn(),
    updateMcpProviderService: jest.fn(),
    createMcpProviderOAuthSession: jest.fn(),
    pollMcpProviderOAuthSession: jest.fn(),
  },
}))

const OAUTH_URL = 'https://mcp-gw.dingtalk.com/oauth/server/aitable'

function serviceConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider_id: 'dingtalk',
    service_id: 'ai_table',
    detail_url: 'https://mcp.dingtalk.com/#/detail?mcpId=9555',
    enabled: false,
    url: '',
    auth_mode: 'url',
    oauth_supported: true,
    oauth_connected: false,
    oauth_expires_at: null,
    oauth_account: null,
    ...overrides,
  }
}

describe('McpProviderConfigDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.open = jest.fn()
  })

  it('defaults supported services to OAuth and guides the user to the OAuth URL', async () => {
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(serviceConfig())

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth')).toBeInTheDocument()
    )
    expect(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth')).toBeEnabled()
    expect(screen.getByText('MCP OAuth URL')).toBeInTheDocument()
    expect(screen.getByText('Click "View MCP Server Config"')).toBeInTheDocument()
    expect(screen.getByText('Copy the "MCP OAuth URL" on the "OAuth 2.0" tab')).toBeInTheDocument()
    expect(screen.getByText('Paste the URL into "MCP OAuth URL" below')).toBeInTheDocument()
    expect(
      screen.getByText('Click "Connect and authorize" to complete DingTalk authorization')
    ).toBeInTheDocument()
    expect(
      screen.getByText('After authorization succeeds, click "Save and Enable"')
    ).toBeInTheDocument()
    expect(screen.getByTestId('save-dingtalk-mcp-dialog-button')).toBeDisabled()
    expect(
      screen.queryByText('Switch to the "API Key" tab and copy the StreamableHttp URL')
    ).not.toBeInTheDocument()
  })

  it('keeps the dialog open after OAuth succeeds and then enables saving', async () => {
    const popup = { close: jest.fn(), location: { replace: jest.fn() } }
    window.open = jest.fn().mockReturnValue(popup)
    ;(userApis.getMcpProviderService as jest.Mock)
      .mockResolvedValueOnce(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
      .mockResolvedValueOnce(
        serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth', oauth_connected: true })
      )
    ;(userApis.updateMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' })
    )
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://example.com/authorize',
      expires_at: 2000000000,
      poll_interval_seconds: 1,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      status: 'success',
    })
    const onOpenChange = jest.fn()

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={onOpenChange}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const connectButton = await screen.findByTestId('dingtalk-ai_table-oauth-connect')
    await waitFor(() => expect(connectButton).toBeEnabled())
    fireEvent.click(connectButton)

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-oauth-connected')).toBeInTheDocument()
    )
    expect(userApis.updateMcpProviderService).toHaveBeenCalledTimes(1)
    expect(userApis.updateMcpProviderService).toHaveBeenCalledWith('dingtalk', 'ai_table', {
      enabled: false,
      url: OAUTH_URL,
      auth_mode: 'oauth',
    })
    expect(popup.location.replace).toHaveBeenCalledWith('https://example.com/authorize')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-dingtalk-mcp-dialog-button')).toBeEnabled()
  })

  it('shows save success beside the save button without closing the dialog', async () => {
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth', oauth_connected: true })
    )
    ;(userApis.updateMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({
        enabled: true,
        url: OAUTH_URL,
        auth_mode: 'oauth',
        oauth_connected: true,
      })
    )
    const onOpenChange = jest.fn()

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={onOpenChange}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const saveButton = await screen.findByTestId('save-dingtalk-mcp-dialog-button')
    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeDisabled()
    )
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    const success = await screen.findByTestId('dingtalk-ai_table-save-success')
    expect(success).toHaveTextContent('Saved and enabled')
    expect(success.parentElement).toContainElement(saveButton)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps a separate OAuth URL draft', async () => {
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValueOnce(
      serviceConfig({
        enabled: false,
        url: OAUTH_URL,
        auth_mode: 'oauth',
      })
    )

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const input = await screen.findByTestId('dingtalk-mcp-dialog-url-input')
    await waitFor(() => expect(input).toHaveValue(OAUTH_URL))

    fireEvent.click(screen.getByTestId('dingtalk-ai_table-auth-mode-url'))
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'https://mcp-gw.dingtalk.com/server/key' } })

    fireEvent.click(screen.getByTestId('dingtalk-ai_table-auth-mode-oauth'))
    expect(input).toHaveValue(OAUTH_URL)
  })

  it('requires reauthorization after changing an authorized OAuth URL', async () => {
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({
        enabled: true,
        url: OAUTH_URL,
        auth_mode: 'oauth',
        oauth_connected: true,
      })
    )

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const input = await screen.findByTestId('dingtalk-mcp-dialog-url-input')
    await waitFor(() => expect(input).toHaveValue(OAUTH_URL))
    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeDisabled()
    expect(screen.getByTestId('save-dingtalk-mcp-dialog-button')).toBeEnabled()

    fireEvent.change(input, { target: { value: `${OAUTH_URL}-new` } })

    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeEnabled()
    expect(screen.queryByTestId('dingtalk-ai_table-oauth-connected')).not.toBeInTheDocument()
    expect(screen.getByTestId('save-dingtalk-mcp-dialog-button')).toBeDisabled()

    fireEvent.change(input, { target: { value: OAUTH_URL } })

    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeDisabled()
    expect(screen.getByTestId('dingtalk-ai_table-oauth-connected')).toBeInTheDocument()
    expect(screen.getByTestId('save-dingtalk-mcp-dialog-button')).toBeEnabled()
  })

  it('restores the previous configuration when OAuth authorization fails', async () => {
    const previousUrl = 'https://mcp-gw.dingtalk.com/server/personal-key'
    const popup = { close: jest.fn(), location: { replace: jest.fn() } }
    window.open = jest.fn().mockReturnValue(popup)
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ enabled: true, url: previousUrl, auth_mode: 'url' })
    )
    ;(userApis.updateMcpProviderService as jest.Mock)
      .mockResolvedValueOnce(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
      .mockResolvedValueOnce(serviceConfig({ enabled: true, url: previousUrl, auth_mode: 'url' }))
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://example.com/authorize',
      expires_at: 2000000000,
      poll_interval_seconds: 1,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      status: 'error',
      error: 'Authorization denied',
    })

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    fireEvent.click(await screen.findByTestId('dingtalk-ai_table-auth-mode-oauth'))
    const input = await screen.findByTestId('dingtalk-mcp-dialog-url-input')
    await waitFor(() => expect(input).toHaveValue(''))
    fireEvent.change(input, { target: { value: OAUTH_URL } })
    fireEvent.click(screen.getByTestId('dingtalk-ai_table-oauth-connect'))

    await waitFor(() =>
      expect(userApis.updateMcpProviderService).toHaveBeenLastCalledWith('dingtalk', 'ai_table', {
        enabled: true,
        url: previousUrl,
        auth_mode: 'url',
      })
    )
    expect(userApis.updateMcpProviderService).toHaveBeenCalledTimes(2)
    expect(popup.close).toHaveBeenCalled()
    expect(input).toHaveValue(OAUTH_URL)
    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeEnabled()
  })

  it('surfaces an error when restoring the previous configuration fails', async () => {
    const previousUrl = 'https://mcp-gw.dingtalk.com/server/personal-key'
    const popup = { close: jest.fn(), location: { replace: jest.fn() } }
    window.open = jest.fn().mockReturnValue(popup)
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ enabled: true, url: previousUrl, auth_mode: 'url' })
    )
    ;(userApis.updateMcpProviderService as jest.Mock)
      .mockResolvedValueOnce(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
      .mockRejectedValueOnce(new Error('Restore failed'))
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://example.com/authorize',
      expires_at: 2000000000,
      poll_interval_seconds: 1,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      status: 'error',
      error: 'Authorization denied',
    })

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    fireEvent.click(await screen.findByTestId('dingtalk-ai_table-auth-mode-oauth'))
    const input = await screen.findByTestId('dingtalk-mcp-dialog-url-input')
    await waitFor(() => expect(input).toHaveValue(''))
    fireEvent.change(input, { target: { value: OAUTH_URL } })
    fireEvent.click(screen.getByTestId('dingtalk-ai_table-oauth-connect'))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'Failed to restore the previous configuration',
        })
      )
    )
  })

  it('polls once more when the authorization window is closed', async () => {
    const popup = { closed: true, close: jest.fn(), location: { replace: jest.fn() } }
    window.open = jest.fn().mockReturnValue(popup)
    ;(userApis.getMcpProviderService as jest.Mock)
      .mockResolvedValueOnce(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
      .mockResolvedValueOnce(
        serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth', oauth_connected: true })
      )
    ;(userApis.updateMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' })
    )
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://example.com/authorize',
      expires_at: 2000000000,
      poll_interval_seconds: 1,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success' })

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const connectButton = await screen.findByTestId('dingtalk-ai_table-oauth-connect')
    await waitFor(() => expect(connectButton).toBeEnabled())
    fireEvent.click(connectButton)

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-oauth-connected')).toBeInTheDocument()
    )
    expect(userApis.pollMcpProviderOAuthSession).toHaveBeenCalledTimes(2)
  })

  it('keeps reconnect disabled until a cancelled OAuth attempt finishes rollback', async () => {
    const popup = { close: jest.fn(), location: { replace: jest.fn() } }
    let resolveRollback!: (value: ReturnType<typeof serviceConfig>) => void
    const rollbackPromise = new Promise<ReturnType<typeof serviceConfig>>(resolve => {
      resolveRollback = resolve
    })
    window.open = jest.fn().mockReturnValue(popup)
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' })
    )
    ;(userApis.updateMcpProviderService as jest.Mock)
      .mockResolvedValueOnce(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
      .mockReturnValueOnce(rollbackPromise)
    ;(userApis.createMcpProviderOAuthSession as jest.Mock).mockResolvedValue({
      session_id: 'session-1',
      poll_token: 'poll-token',
      authorize_url: 'https://example.com/authorize',
      expires_at: 2000000000,
      poll_interval_seconds: 1,
    })
    ;(userApis.pollMcpProviderOAuthSession as jest.Mock)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'error', error: 'Authorization denied' })

    const view = render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    const connectButton = await screen.findByTestId('dingtalk-ai_table-oauth-connect')
    await waitFor(() => expect(connectButton).toBeEnabled())
    fireEvent.click(connectButton)

    view.rerender(
      <McpProviderConfigDialog
        open={false}
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )
    view.rerender(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeDisabled()
    )
    await waitFor(() => expect(userApis.updateMcpProviderService).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeDisabled()

    resolveRollback(serviceConfig({ url: OAUTH_URL, auth_mode: 'oauth' }))
    await waitFor(() => expect(screen.getByTestId('dingtalk-ai_table-oauth-connect')).toBeEnabled())
  })

  it('keeps API Key mode available when OAuth is unsupported', async () => {
    ;(userApis.getMcpProviderService as jest.Mock).mockResolvedValue(
      serviceConfig({ oauth_supported: false })
    )

    render(
      <McpProviderConfigDialog
        open
        onOpenChange={jest.fn()}
        providerId="dingtalk"
        serviceId="ai_table"
      />
    )

    expect(
      await screen.findByText('Switch to the "API Key" tab and copy the StreamableHttp URL')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-ai_table-auth-mode-oauth')).not.toBeInTheDocument()
  })
})
