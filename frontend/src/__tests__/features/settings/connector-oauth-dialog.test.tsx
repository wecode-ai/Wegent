// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import ConnectorOAuthDialog from '@/features/settings/components/ConnectorOAuthDialog'
import * as connectorOAuth from '@/features/settings/connectorOAuth'

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

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getUserConnectorApps: jest.fn(),
    createConnectorOAuthSession: jest.fn(),
    pollConnectorOAuthSession: jest.fn(),
  },
}))

jest.mock('@/features/settings/connectorOAuth', () => {
  const actual = jest.requireActual('@/features/settings/connectorOAuth')
  return {
    ...actual,
    authorizeConnectorApp: jest.fn(actual.authorizeConnectorApp),
  }
})

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

const app = {
  id: 7,
  slug: 'dingtalk-mcp-generic',
  name: 'DingTalk MCP Generic',
  description: 'DingTalk AI table',
  icon_url: null,
  auth_type: 'oauth2' as const,
  tool_loading_mode: 'static' as const,
  connection: { status: 'disconnected' as const },
}

describe('ConnectorOAuthDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('loads the linked app and starts its OAuth flow', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([app])
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
    const onOpenChange = jest.fn()

    render(<ConnectorOAuthDialog open slug="dingtalk-mcp-generic" onOpenChange={onOpenChange} />)

    expect(await screen.findByText('DingTalk MCP Generic')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('connector-oauth-authorize'))

    await waitFor(() =>
      expect(mockedAdminApis.createConnectorOAuthSession).toHaveBeenCalledWith(
        'dingtalk-mcp-generic'
      )
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(openSpy).toHaveBeenCalledWith('/mcp-oauth-pending.html', '_blank')
    expect(replace).toHaveBeenCalledWith('https://oauth.example.test/authorize')
    expect(mockToast).toHaveBeenCalledWith({
      title: 'common:integrations.connector_apps.authorized',
    })
    openSpy.mockRestore()
  })

  it('reports apps that are not visible to the user', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([])

    render(<ConnectorOAuthDialog open slug="missing-app" onOpenChange={jest.fn()} />)

    expect(await screen.findByTestId('connector-oauth-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-oauth-authorize')).not.toBeInTheDocument()
  })

  it('lets the user retry after a transient load failure', async () => {
    mockedAdminApis.getUserConnectorApps
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce([app])

    render(<ConnectorOAuthDialog open slug="dingtalk-mcp-generic" onOpenChange={jest.fn()} />)

    expect(await screen.findByTestId('connector-oauth-load-error')).toBeInTheDocument()
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('retry-connector-oauth-load'))

    expect(await screen.findByText('DingTalk MCP Generic')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-oauth-load-error')).not.toBeInTheDocument()
  })

  it('hides the authorize action when the app is already connected', async () => {
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([
      { ...app, connection: { status: 'connected', external_account_name: 'chenbo' } },
    ])

    render(<ConnectorOAuthDialog open slug="dingtalk-mcp-generic" onOpenChange={jest.fn()} />)

    expect(await screen.findByText('DingTalk MCP Generic')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-oauth-authorize')).not.toBeInTheDocument()
  })

  it('ignores a late catalog response after switching the linked app', async () => {
    const nextApp = { ...app, id: 8, slug: 'another-app', name: 'Another App' }
    let resolveOld!: (value: Awaited<ReturnType<typeof adminApis.getUserConnectorApps>>) => void
    mockedAdminApis.getUserConnectorApps
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce([nextApp])
    const { rerender } = render(
      <ConnectorOAuthDialog open slug={app.slug} onOpenChange={jest.fn()} />
    )
    await waitFor(() => expect(mockedAdminApis.getUserConnectorApps).toHaveBeenCalledTimes(1))

    rerender(<ConnectorOAuthDialog open slug={nextApp.slug} onOpenChange={jest.fn()} />)
    expect(await screen.findByText(nextApp.name)).toBeInTheDocument()
    await act(async () => resolveOld([app]))

    expect(screen.getByText(nextApp.name)).toBeInTheDocument()
    expect(screen.queryByText(app.name)).not.toBeInTheDocument()
  })

  it('ignores load failures from a dialog that has already closed', async () => {
    let rejectOld!: (reason: Error) => void
    mockedAdminApis.getUserConnectorApps.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject
        })
    )
    const { rerender } = render(
      <ConnectorOAuthDialog open slug={app.slug} onOpenChange={jest.fn()} />
    )
    await waitFor(() => expect(mockedAdminApis.getUserConnectorApps).toHaveBeenCalledTimes(1))
    rerender(<ConnectorOAuthDialog open={false} slug={app.slug} onOpenChange={jest.fn()} />)

    await act(async () => rejectOld(new Error('Old catalog failed')))

    expect(mockToast).not.toHaveBeenCalled()
  })

  it('does not close a new dialog when the previous authorization completes', async () => {
    const nextApp = { ...app, id: 8, slug: 'another-app', name: 'Another App' }
    mockedAdminApis.getUserConnectorApps.mockResolvedValue([app, nextApp])
    let completeOld!: () => void
    jest.mocked(connectorOAuth.authorizeConnectorApp).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          completeOld = resolve
        })
    )
    const onOpenChange = jest.fn()
    const onAuthorized = jest.fn()
    const { rerender } = render(
      <ConnectorOAuthDialog
        open
        slug={app.slug}
        onOpenChange={onOpenChange}
        onAuthorized={onAuthorized}
      />
    )
    expect(await screen.findByText(app.name)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('connector-oauth-authorize'))

    rerender(
      <ConnectorOAuthDialog
        open
        slug={nextApp.slug}
        onOpenChange={onOpenChange}
        onAuthorized={onAuthorized}
      />
    )
    expect(await screen.findByText(nextApp.name)).toBeInTheDocument()
    await act(async () => completeOld())

    expect(screen.getByText(nextApp.name)).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onAuthorized).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })
})
