import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { WegentConnectorApp, WegentConnectorConnection } from '@/api/cloud/connectorApps'
import { ConnectorConnectionsSection } from './ConnectorConnectionsSection'

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  installed: vi.fn(),
  refresh: vi.fn(),
  authorize: vi.fn(),
  changed: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@/api/cloud/connectorApps', () => ({
  listWegentConnectorApps: api.catalog,
  listWegentInstalledConnectorApps: api.installed,
  refreshWegentConnector: api.refresh,
  authorizeWegentConnector: api.authorize,
  connectorAuthorizationErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  notifyConnectorAuthorizationChanged: api.changed,
}))
vi.mock('@/lib/cloud-authorization-window', () => ({ openCloudAuthorizationWindow: api.open }))

const connection = (status: WegentConnectorConnection['status']): WegentConnectorConnection => ({
  status,
  external_account_name: null,
  granted_scopes: [],
  expires_at: null,
})

const app = (status: WegentConnectorConnection['status']): WegentConnectorApp => ({
  id: 1,
  slug: 'scope-test',
  name: 'Scope test',
  description: '',
  icon_url: null,
  auth_type: 'oauth2',
  tool_loading_mode: 'lazy',
  connection: connection(status),
})

const props = { apiBaseUrl: 'https://wegent.test/api', token: 'account-a-token' }

describe('ConnectorConnectionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.catalog.mockReset().mockResolvedValue([app('disconnected')])
    api.installed.mockReset().mockResolvedValue({ apps: [] })
    api.authorize.mockReset().mockResolvedValue(connection('connected'))
    api.refresh.mockReset().mockResolvedValue(connection('connected'))
  })

  test('shows unauthorized catalog apps without depending on device or model requests', async () => {
    render(<ConnectorConnectionsSection {...props} />)
    expect(await screen.findByTestId('connector-authorize-scope-test')).toBeEnabled()
    expect(api.catalog).toHaveBeenCalledExactlyOnceWith(props.apiBaseUrl, props.token)
    expect(api.installed).toHaveBeenCalledExactlyOnceWith(props.apiBaseUrl, props.token)
  })

  test('does not fetch without a cloud identity', async () => {
    render(<ConnectorConnectionsSection apiBaseUrl={null} token={null} />)
    expect(await screen.findByText('暂无应用连接')).toBeInTheDocument()
    expect(api.catalog).not.toHaveBeenCalled()
    expect(api.installed).not.toHaveBeenCalled()
  })

  test('distinguishes failed discovery from an empty catalog and supports retry', async () => {
    api.catalog.mockRejectedValueOnce(new Error('Unavailable'))
    render(<ConnectorConnectionsSection {...props} />)
    expect(await screen.findByTestId('connector-connections-error')).toBeInTheDocument()
    expect(screen.queryByText('暂无应用连接')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('connector-connections-retry'))
    expect(await screen.findByTestId('connector-authorize-scope-test')).toBeEnabled()
    expect(screen.queryByTestId('connector-connections-error')).not.toBeInTheDocument()
  })

  test('does not open OAuth automatically when refreshing an expired grant fails', async () => {
    api.catalog.mockResolvedValue([app('expired')])
    api.refresh.mockRejectedValue(new Error('Provider temporarily unavailable'))
    render(<ConnectorConnectionsSection {...props} />)
    fireEvent.click(await screen.findByTestId('connector-refresh-scope-test'))
    expect(await screen.findByTestId('connector-connections-error')).toHaveTextContent(
      'Provider temporarily unavailable'
    )
    expect(api.authorize).not.toHaveBeenCalled()
    expect(api.changed).not.toHaveBeenCalled()
    expect(screen.getByTestId('connector-authorize-scope-test')).toBeEnabled()
    fireEvent.click(screen.getByTestId('connector-authorize-scope-test'))
    await waitFor(() => expect(api.authorize).toHaveBeenCalledTimes(1))
  })

  test('reloads the authoritative catalog and notifies the runtime after refresh succeeds', async () => {
    api.catalog.mockResolvedValueOnce([app('expired')]).mockResolvedValue([app('connected')])
    render(<ConnectorConnectionsSection {...props} />)
    fireEvent.click(await screen.findByTestId('connector-refresh-scope-test'))
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(2))
    expect(api.changed).toHaveBeenCalledTimes(1)
    expect(api.authorize).not.toHaveBeenCalled()
    expect(await screen.findByText('已连接')).toBeInTheDocument()
    expect(screen.queryByTestId('connector-refresh-scope-test')).not.toBeInTheDocument()
  })

  test.each(['resolve', 'reject'] as const)(
    'isolates a late authorization %s from a new account',
    async outcome => {
      let finish!: () => void
      api.authorize.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === 'resolve'
                ? resolve(connection('connected'))
                : reject(new Error('Old identity failure'))
          })
      )
      const view = render(<ConnectorConnectionsSection {...props} />)
      fireEvent.click(await screen.findByTestId('connector-authorize-scope-test'))
      const isCurrent = api.authorize.mock.calls[0][4].isCurrent as () => boolean
      expect(isCurrent()).toBe(true)
      view.rerender(<ConnectorConnectionsSection {...props} token="account-b-token" />)
      expect(isCurrent()).toBe(false)
      expect(await screen.findByTestId('connector-authorize-scope-test')).toBeEnabled()
      await act(async () => finish())
      expect(screen.queryByTestId('connector-connections-error')).not.toBeInTheDocument()
      expect(screen.getByTestId('connector-authorize-scope-test')).toBeEnabled()
      expect(api.catalog).toHaveBeenCalledTimes(2)
      expect(api.catalog).toHaveBeenLastCalledWith(props.apiBaseUrl, 'account-b-token')
    }
  )

  test('clears the previous catalog immediately on account changes and ignores late reads', async () => {
    let finish!: (apps: WegentConnectorApp[]) => void
    api.catalog
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue([])
    const view = render(<ConnectorConnectionsSection {...props} />)
    view.rerender(<ConnectorConnectionsSection {...props} token="account-b-token" />)
    expect(await screen.findByText('暂无应用连接')).toBeInTheDocument()
    await act(async () => finish([app('connected')]))
    expect(screen.queryByTestId('connector-connection-scope-test')).not.toBeInTheDocument()
    expect(screen.getByText('暂无应用连接')).toBeInTheDocument()
  })

  test('ends authorization when the settings section unmounts', async () => {
    let finish!: () => void
    api.authorize.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve(connection('connected'))
        })
    )
    const view = render(<ConnectorConnectionsSection {...props} />)
    fireEvent.click(await screen.findByTestId('connector-authorize-scope-test'))
    const isCurrent = api.authorize.mock.calls[0][4].isCurrent as () => boolean
    view.unmount()
    expect(isCurrent()).toBe(false)
    await act(async () => finish())
    expect(api.catalog).toHaveBeenCalledTimes(1)
  })
})
