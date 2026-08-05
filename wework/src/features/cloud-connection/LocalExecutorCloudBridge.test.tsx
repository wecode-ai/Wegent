import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudBridge'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensure: vi.fn().mockResolvedValue({ running: true, ready: true }),
  runtimeTokenPost: vi.fn(),
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
  listWegentInstalledConnectorApps: mocks.listApps,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({
    post: mocks.runtimeTokenPost,
  })),
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
    mocks.runtimeTokenPost.mockResolvedValue({
      auth_token: 'runtime-task-token',
      token_type: 'bearer',
      expires_in: 86400,
    })
    mocks.listApps.mockResolvedValue({
      apps: [
        {
          id: 'tickets',
          slug: 'tickets',
          runtime_name: 'Tickets',
          enabled: true,
          callable: true,
          connection: { status: 'connected' },
          tool_summaries: [{ name: 'tickets__search', raw_tool_name: 'search' }],
        },
        {
          id: 'docs',
          slug: 'docs',
          runtime_name: 'Docs',
          enabled: true,
          callable: false,
          connection: { status: 'connected' },
        },
      ],
    })
  })

  async function flushAsyncEffects() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  test('updates backend connection whenever the cloud target changes', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        socketBaseUrl: 'wss://socket.example.com',
        authToken: 'token-a',
        runtimeAuthToken: 'runtime-task-token',
      })
    })

    view.rerender(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://next.example.com/api"
        backendUrl="https://next.example.com"
        socketBaseUrl="wss://next-socket.example.com"
        isConnected
        token="token-b"
      />
    )
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2))
    expect(mocks.connect).toHaveBeenLastCalledWith({
      backendUrl: 'https://next.example.com',
      socketBaseUrl: 'wss://next-socket.example.com',
      authToken: 'token-b',
      runtimeAuthToken: 'runtime-task-token',
    })
  })

  test('does not update backend connection when runtime token issuing fails', async () => {
    mocks.runtimeTokenPost.mockRejectedValue(new Error('runtime token unavailable'))

    render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() => {
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(1)
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  test('refreshes the runtime auth token before it expires', async () => {
    vi.useFakeTimers()
    mocks.runtimeTokenPost
      .mockResolvedValueOnce({
        auth_token: 'runtime-task-token-1',
        token_type: 'bearer',
        expires_in: 2,
      })
      .mockResolvedValueOnce({
        auth_token: 'runtime-task-token-2',
        token_type: 'bearer',
        expires_in: 86400,
      })

    const view = render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    try {
      await flushAsyncEffects()

      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        socketBaseUrl: 'wss://socket.example.com',
        authToken: 'token-a',
        runtimeAuthToken: 'runtime-task-token-1',
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      await flushAsyncEffects()

      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        socketBaseUrl: 'wss://socket.example.com',
        authToken: 'token-a',
        runtimeAuthToken: 'runtime-task-token-2',
      })
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('clears a pending runtime token refresh when the target changes', async () => {
    vi.useFakeTimers()
    mocks.runtimeTokenPost.mockResolvedValue({
      auth_token: 'runtime-task-token',
      token_type: 'bearer',
      expires_in: 2,
    })

    const view = render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    try {
      await flushAsyncEffects()
      expect(mocks.connect).toHaveBeenCalledTimes(1)

      view.rerender(
        <LocalExecutorCloudBridge
          apiBaseUrl="https://next.example.com/api"
          backendUrl="https://next.example.com"
          socketBaseUrl="wss://next-socket.example.com"
          isConnected
          token="token-b"
        />
      )

      await flushAsyncEffects()
      expect(mocks.connect).toHaveBeenCalledTimes(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      await flushAsyncEffects()
      expect(mocks.connect).toHaveBeenCalledTimes(3)
      expect(mocks.connect).toHaveBeenLastCalledWith({
        backendUrl: 'https://next.example.com',
        socketBaseUrl: 'wss://next-socket.example.com',
        authToken: 'token-b',
        runtimeAuthToken: 'runtime-task-token',
      })
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('passes only a short-lived scoped token and syncs connected apps', async () => {
    render(
      <LocalExecutorCloudBridge
        apiBaseUrl="https://cloud.example.test/api"
        backendUrl="https://cloud.example.test"
        socketBaseUrl="wss://socket.example.test"
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
      apps: [
        {
          slug: 'tickets',
          name: 'Tickets',
          description: '',
          tools: [{ name: 'tickets__search', raw_tool_name: 'search' }],
        },
      ],
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
