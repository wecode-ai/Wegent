import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudBridge'
import {
  resetLocalExecutorCloudConnectionStatus,
  useLocalExecutorCloudConnectionStatus,
} from './localExecutorCloudConnectionStatus'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnect: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensure: vi.fn().mockResolvedValue({ running: true, ready: true }),
  runtimeTokenPost: vi.fn(),
  issueToken: vi.fn(),
  listApps: vi.fn(),
  request: vi.fn().mockResolvedValue({}),
  notifySkillsChanged: vi.fn(),
  backendConnected: true,
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

vi.mock('@/desktop/localExecutor', () => ({
  connectLocalExecutorToBackend: mocks.connect,
  disconnectLocalExecutorFromBackend: mocks.disconnect,
  ensureLocalExecutorAvailable: mocks.ensure,
  requestLocalExecutor: mocks.request,
}))

vi.mock('@/features/plugins/pluginTrial', () => ({
  notifyLocalPluginSkillsChanged: mocks.notifySkillsChanged,
}))

describe('LocalExecutorCloudBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalExecutorCloudConnectionStatus()
    mocks.backendConnected = true
    mocks.connect.mockResolvedValue({ running: true, ready: true })
    mocks.request.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'executor.backend.status'
          ? { configured: true, connected: mocks.backendConnected }
          : {}
      )
    )
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

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  function ConnectionStatusProbe() {
    const status = useLocalExecutorCloudConnectionStatus()
    return (
      <span data-testid="local-executor-cloud-connection-status">
        {status.connected ? `connected:${status.apiBaseUrl}` : 'disconnected'}
      </span>
    )
  }

  test('publishes whether the executor WebSocket connection succeeded', async () => {
    const view = render(
      <>
        <LocalExecutorCloudBridge
          preferencesLoaded
          apiBaseUrl="https://backend.example.com/api"
          backendUrl="https://backend.example.com"
          socketBaseUrl="wss://socket.example.com"
          isConnected
          token="token-a"
        />
        <ConnectionStatusProbe />
      </>
    )

    await waitFor(() =>
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'connected:https://backend.example.com/api'
      )
    )

    mocks.connect.mockRejectedValueOnce(new Error('socket unavailable'))
    view.rerender(
      <>
        <LocalExecutorCloudBridge
          preferencesLoaded
          apiBaseUrl="https://offline.example.com/api"
          backendUrl="https://offline.example.com"
          socketBaseUrl="wss://offline.example.com"
          isConnected
          token="token-b"
        />
        <ConnectionStatusProbe />
      </>
    )

    await waitFor(() =>
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'disconnected'
      )
    )
  })

  test('publishes a later WebSocket disconnect', async () => {
    render(
      <>
        <LocalExecutorCloudBridge
          preferencesLoaded
          apiBaseUrl="https://backend.example.com/api"
          backendUrl="https://backend.example.com"
          socketBaseUrl="wss://socket.example.com"
          isConnected
          token="token-a"
        />
        <ConnectionStatusProbe />
      </>
    )

    await waitFor(() =>
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'connected:https://backend.example.com/api'
      )
    )

    mocks.backendConnected = false

    await waitFor(
      () =>
        expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
          'disconnected'
        ),
      { timeout: 2_000 }
    )
  })

  test('clears the published connection when the bridge unmounts', async () => {
    const view = render(
      <>
        <LocalExecutorCloudBridge
          preferencesLoaded
          apiBaseUrl="https://backend.example.com/api"
          backendUrl="https://backend.example.com"
          socketBaseUrl="wss://socket.example.com"
          isConnected
          token="token-a"
        />
        <ConnectionStatusProbe />
      </>
    )

    await waitFor(() =>
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'connected:https://backend.example.com/api'
      )
    )

    view.unmount()
    render(<ConnectionStatusProbe />)

    expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
      'disconnected'
    )
  })

  test('updates backend connection whenever the cloud target changes', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
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
        deviceType: 'app',
      })
    })

    view.rerender(
      <LocalExecutorCloudBridge
        preferencesLoaded
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
      deviceType: 'app',
    })
  })

  test('waits for preferences before registering the executor', async () => {
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded={false}
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    await flushAsyncEffects()
    expect(mocks.runtimeTokenPost).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()

    view.rerender(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://backend.example.com/api"
        backendUrl="https://backend.example.com"
        socketBaseUrl="wss://socket.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ deviceType: 'app' }))
    )
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })

  test('does not update backend connection when runtime token issuing fails', async () => {
    mocks.runtimeTokenPost.mockRejectedValue(new Error('runtime token unavailable'))

    render(
      <LocalExecutorCloudBridge
        preferencesLoaded
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
        preferencesLoaded
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
        deviceType: 'app',
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
        deviceType: 'app',
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
        preferencesLoaded
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
          preferencesLoaded
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
        deviceType: 'app',
      })
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('ignores a stale deferred runtime token after the cloud target changes', async () => {
    const firstToken = deferred<{
      auth_token: string
      token_type: string
      expires_in: number
    }>()
    const secondToken = deferred<{
      auth_token: string
      token_type: string
      expires_in: number
    }>()
    mocks.runtimeTokenPost
      .mockReturnValueOnce(firstToken.promise)
      .mockReturnValueOnce(secondToken.promise)

    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://backend-a.example.com/api"
        backendUrl="https://backend-a.example.com"
        socketBaseUrl="wss://socket-a.example.com"
        isConnected
        token="token-a"
      />
    )

    await waitFor(() => expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(1))

    view.rerender(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://backend-b.example.com/api"
        backendUrl="https://backend-b.example.com"
        socketBaseUrl="wss://socket-b.example.com"
        isConnected
        token="token-b"
      />
    )

    await waitFor(() => expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2))

    await act(async () => {
      firstToken.resolve({
        auth_token: 'runtime-task-token-a',
        token_type: 'bearer',
        expires_in: 86400,
      })
      await firstToken.promise
    })

    await flushAsyncEffects()
    expect(mocks.connect).not.toHaveBeenCalled()

    await act(async () => {
      secondToken.resolve({
        auth_token: 'runtime-task-token-b',
        token_type: 'bearer',
        expires_in: 86400,
      })
      await secondToken.promise
    })

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        backendUrl: 'https://backend-b.example.com',
        socketBaseUrl: 'wss://socket-b.example.com',
        authToken: 'token-b',
        runtimeAuthToken: 'runtime-task-token-b',
        deviceType: 'app',
      })
    })
  })

  test('passes only a short-lived scoped token and syncs connected apps', async () => {
    render(
      <LocalExecutorCloudBridge
        preferencesLoaded
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
    render(<LocalExecutorCloudBridge preferencesLoaded isConnected={false} token={null} />)

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
