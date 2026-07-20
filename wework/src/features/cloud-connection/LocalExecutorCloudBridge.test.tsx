import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudBridge'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensure: vi.fn().mockResolvedValue({ running: true, ready: true }),
  issueToken: vi.fn(),
  listApps: vi.fn(),
  request: vi.fn().mockResolvedValue({}),
  notifySkillsChanged: vi.fn(),
}))

vi.mock('./cloudConnectionAvailability', () => ({
  isCloudConnectionUiAvailable: () => true,
}))

vi.mock('@/api/cloud/connectorApps', () => ({
  issueWegentConnectorToken: mocks.issueToken,
  listWegentConnectorApps: mocks.listApps,
}))

vi.mock('@/tauri/localExecutor', () => ({
  connectLocalExecutorToBackend: mocks.connect,
  disconnectLocalExecutorFromBackend: mocks.disconnect,
  ensureLocalExecutorStarted: mocks.ensure,
  requestLocalExecutor: mocks.request,
}))

vi.mock('@/features/plugins/pluginTrial', () => ({
  notifyLocalPluginSkillsChanged: mocks.notifySkillsChanged,
}))

describe('LocalExecutorCloudBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.issueToken.mockResolvedValue({
      access_token: 'scoped-connector-token',
      token_type: 'bearer',
      expires_in: 900,
    })
    mocks.listApps.mockResolvedValue([
      {
        id: 1,
        slug: 'tickets',
        name: 'Tickets',
        connection: { status: 'connected' },
      },
      {
        id: 2,
        slug: 'docs',
        name: 'Docs',
        connection: { status: 'disconnected' },
      },
    ])
  })

  test('updates backend connection whenever the cloud target changes', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        authToken: 'token-a',
      })
    })

    view.rerender(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://next.example.com/api"
        backendUrl="https://next.example.com"
        isConnected
        token="token-b"
      />
    )
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2))
    expect(mocks.connect).toHaveBeenLastCalledWith({
      backendUrl: 'https://next.example.com',
      authToken: 'token-b',
    })
  })

  test('passes only a short-lived scoped token and syncs connected apps', async () => {
    render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://cloud.example.test/api"
        backendUrl="https://cloud.example.test"
        isConnected
        token="cloud-token"
      />
    )

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith(
        'runtime.connectors.configure',
        expect.objectContaining({
          apiBaseUrl: 'https://cloud.example.test/api',
          connectorToken: 'scoped-connector-token',
          syncRevision: expect.any(Number),
        })
      )
    })
    expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.apps.sync', {
      apps: [{ slug: 'tickets', name: 'Tickets' }],
    })
    expect(mocks.notifySkillsChanged).toHaveBeenCalled()
    expect(
      mocks.request.mock.calls.find(call => call[0] === 'runtime.connectors.configure')?.[1]
    ).not.toHaveProperty('authToken')
  })

  test('disconnects the executor and clears connector state when cloud is unavailable', async () => {
    render(<LocalExecutorCloudBridge isConnected={false} token={null} />)

    await waitFor(() => {
      expect(mocks.disconnect).toHaveBeenCalledTimes(1)
      expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.clear', {
        syncRevision: expect.any(Number),
      })
    })
    expect(mocks.ensure).toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.notifySkillsChanged).toHaveBeenCalled()
  })
})
