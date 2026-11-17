import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudBridge'
import { connectedCloudBridge } from './localExecutorCloudBridgeFixture'
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
  listCatalog: vi.fn(),
  request: vi.fn().mockResolvedValue({}),
  notifySkillsChanged: vi.fn(),
  backendConnected: true,
  pluginAuth: vi.fn(),
}))

vi.mock('./cloudConnectionAvailability', () => ({
  isCloudConnectionUiAvailable: () => true,
}))

vi.mock('@/lib/runtime-mode', () => ({
  isLocalFirstAppRuntime: () => true,
}))

vi.mock('@/api/cloud/connectorApps', () => ({
  issueWegentConnectorToken: mocks.issueToken,
  listWegentInstalledConnectorApps: mocks.listApps,
  listWegentConnectorApps: mocks.listCatalog,
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

vi.mock('@/features/plugins/pluginNativeAuthorization', () => ({
  configurePluginNativeAuthorization: mocks.pluginAuth,
}))

vi.mock('@/features/plugins/pluginTrial', () => ({
  notifyLocalPluginSkillsChanged: mocks.notifySkillsChanged,
}))

describe('LocalExecutorCloudBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalExecutorCloudConnectionStatus()
    mocks.backendConnected = true
    mocks.pluginAuth.mockResolvedValue({ ready: true, expiresIn: null })
    mocks.connect.mockResolvedValue({ running: true, ready: true })
    mocks.request.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'executor.backend.status'
          ? { configured: true, connected: mocks.backendConnected }
          : { changed: true }
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
    mocks.listCatalog.mockResolvedValue([
      {
        id: 1,
        slug: 'tickets',
        name: 'Tickets',
        description: '',
        icon_url: null,
        auth_type: 'oauth2',
        connection: { status: 'connected' },
      },
    ])
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

  test('a pending plugin session does not delay unrelated cloud initialization', async () => {
    const pending = deferred<{ ready: boolean; expiresIn: number | null }>()
    mocks.pluginAuth.mockReturnValue(pending.promise)
    const view = render(
      <>
        {connectedCloudBridge()}
        <ConnectionStatusProbe />
      </>
    )
    try {
      await waitFor(() => expect(mocks.issueToken).toHaveBeenCalledTimes(1))
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'connected:'
      )
      expect(mocks.disconnect).not.toHaveBeenCalled()
      pending.resolve({ ready: true, expiresIn: 600 })
      await flushAsyncEffects()
    } finally {
      view.unmount()
    }
  })

  test('retries plugin provisioning through the existing timer without offlining the device', async () => {
    vi.useFakeTimers()
    mocks.pluginAuth
      .mockResolvedValueOnce({ ready: false, expiresIn: null })
      .mockResolvedValue({ ready: true, expiresIn: 600 })
    const view = render(
      <>
        {connectedCloudBridge()}
        <ConnectionStatusProbe />
      </>
    )
    try {
      await flushAsyncEffects()
      expect(screen.getByTestId('local-executor-cloud-connection-status')).toHaveTextContent(
        'connected:'
      )
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999)
      })
      expect(mocks.pluginAuth).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(mocks.pluginAuth).toHaveBeenCalledTimes(2)
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(1)
      expect(mocks.issueToken).toHaveBeenCalledTimes(1)
      expect(mocks.disconnect).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('renews a shorter plugin session without reconfiguring other services', async () => {
    vi.useFakeTimers()
    mocks.pluginAuth.mockResolvedValue({ ready: true, expiresIn: 2 })
    const view = render(connectedCloudBridge())
    try {
      await flushAsyncEffects()
      expect(mocks.pluginAuth).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.pluginAuth).toHaveBeenCalledTimes(2)
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(1)
      expect(mocks.issueToken).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('plugin provisioning failure cannot postpone Runtime token renewal', async () => {
    vi.useFakeTimers()
    mocks.runtimeTokenPost
      .mockResolvedValueOnce({ auth_token: 'short-runtime-token', expires_in: 2 })
      .mockResolvedValue({ auth_token: 'renewed-runtime-token', expires_in: 86400 })
    mocks.pluginAuth.mockResolvedValue({ ready: false, expiresIn: null })
    const view = render(connectedCloudBridge())
    try {
      await flushAsyncEffects()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
      expect(mocks.connect).toHaveBeenCalledTimes(2)
      expect(mocks.disconnect).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('publishes whether the executor WebSocket connection succeeded', async () => {
    const view = render(
      <>
        {connectedCloudBridge()}
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
        {connectedCloudBridge()}
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
        {connectedCloudBridge()}
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
    const view = render(connectedCloudBridge())

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
    const view = render(connectedCloudBridge({ preferencesLoaded: false }))

    await flushAsyncEffects()
    expect(mocks.runtimeTokenPost).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()

    view.rerender(connectedCloudBridge())

    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ deviceType: 'app' }))
    )
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })

  test('does not update backend connection when runtime token issuing fails', async () => {
    mocks.runtimeTokenPost.mockRejectedValue(new Error('runtime token unavailable'))

    render(connectedCloudBridge())

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

    const view = render(connectedCloudBridge())

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

  test('reconfigures a restarted Executor but leaves socket reconnects to the Executor', async () => {
    vi.useFakeTimers()
    let configured = true
    mocks.request.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'executor.backend.status'
          ? { configured, connected: configured && mocks.backendConnected }
          : { changed: false }
      )
    )
    const view = render(connectedCloudBridge())
    try {
      await flushAsyncEffects()
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      mocks.backendConnected = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      configured = false
      mocks.connect.mockImplementationOnce(async () => {
        configured = true
        mocks.backendConnected = true
        mocks.pluginAuth.mockResolvedValue({ ready: true, expiresIn: null })
        return { running: true, ready: true }
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      await flushAsyncEffects()
      expect(mocks.connect).toHaveBeenCalledTimes(2)
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
      expect(mocks.issueToken).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('does not undo an explicit native disconnect while still polling for restart', async () => {
    vi.useFakeTimers()
    let explicitlyDisconnected = false
    mocks.request.mockImplementation(async (method: string) =>
      method === 'executor.backend.status'
        ? {
            configured: !explicitlyDisconnected,
            connected: !explicitlyDisconnected,
            explicitly_disconnected: explicitlyDisconnected,
          }
        : { changed: false }
    )
    const view = render(connectedCloudBridge({ apiBaseUrl: '/api' }))
    try {
      await flushAsyncEffects()
      explicitlyDisconnected = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(1)
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('keeps polling across a failed restart reconfiguration without bypassing retry backoff', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let configured = true
    mocks.request.mockImplementation(async (method: string) =>
      method === 'executor.backend.status'
        ? { configured, connected: configured }
        : { changed: false }
    )
    mocks.connect.mockImplementation(async () => {
      configured = true
      return { running: true, ready: true }
    })
    const view = render(connectedCloudBridge({ apiBaseUrl: '/api' }))
    try {
      await flushAsyncEffects()
      configured = false
      mocks.runtimeTokenPost.mockRejectedValueOnce(new Error('temporary token failure'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
      expect(mocks.issueToken).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000)
      })
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
      vi.setSystemTime(Date.now() - 1_000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(2)
      expect(mocks.issueToken).toHaveBeenCalledTimes(2)
      configured = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(3)
    } finally {
      view.unmount()
      error.mockRestore()
      vi.useRealTimers()
    }
  })

  test('keeps polling when restart recovery is coalesced with an in-flight token refresh', async () => {
    vi.useFakeTimers()
    let configured = true
    const renewal = deferred<{ auth_token: string; expires_in: number }>()
    mocks.runtimeTokenPost
      .mockResolvedValueOnce({ auth_token: 'initial', expires_in: 2 })
      .mockReturnValueOnce(renewal.promise)
    mocks.request.mockImplementation(async (method: string) =>
      method === 'executor.backend.status'
        ? { configured, connected: configured }
        : { changed: false }
    )
    mocks.connect.mockImplementation(async () => {
      configured = true
      return { running: true, ready: true }
    })
    const view = render(connectedCloudBridge({ apiBaseUrl: '/api' }))
    try {
      await flushAsyncEffects()
      configured = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
      await act(async () => {
        renewal.resolve({ auth_token: 'renewed', expires_in: 86400 })
      })
      expect(mocks.connect).toHaveBeenCalledTimes(2)
      configured = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(mocks.connect).toHaveBeenCalledTimes(3)
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

    const view = render(connectedCloudBridge())

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

  test('startup has one connection owner and cannot restore a stale socket after metadata resolves', async () => {
    const initialToken = deferred<{ auth_token: string; token_type: string }>()
    const currentToken = deferred<{ auth_token: string; token_type: string }>()
    let metadataResolved = false
    mocks.runtimeTokenPost.mockImplementation(() =>
      metadataResolved ? currentToken.promise : initialToken.promise
    )
    const connection = {
      apiBaseUrl: 'https://backend.example.com/api',
      backendUrl: 'https://backend.example.com',
      socketBaseUrl: 'https://backend.example.com',
      isConnected: true,
      token: 'token-a',
    }
    const renderStartup = (socketBaseUrl: string) => (
      <LocalRuntimeInitializer>
        <LocalExecutorCloudBridge {...connection} socketBaseUrl={socketBaseUrl} preferencesLoaded />
        <div data-testid="ready-workbench" />
      </LocalRuntimeInitializer>
    )
    const view = render(renderStartup(connection.socketBaseUrl))
    expect(await screen.findByTestId('ready-workbench')).toBeInTheDocument()
    await flushAsyncEffects()
    metadataResolved = true
    view.rerender(renderStartup('wss://socket.example.com'))
    await act(async () => {
      currentToken.resolve({ auth_token: 'current-runtime-token', token_type: 'bearer' })
    })
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    await act(async () => {
      initialToken.resolve({ auth_token: 'stale-runtime-token', token_type: 'bearer' })
    })
    await flushAsyncEffects()
    expect(mocks.connect).toHaveBeenLastCalledWith({
      backendUrl: connection.backendUrl,
      socketBaseUrl: 'wss://socket.example.com',
      authToken: connection.token,
      runtimeAuthToken: 'current-runtime-token',
      deviceType: 'app',
    })
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.runtimeTokenPost).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('ready-workbench')).toBeVisible()
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
    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.apps.sync', {
        syncRevision: expect.any(Number),
        apps: [
          {
            slug: 'tickets',
            name: 'Tickets',
            description: '',
            toolLoadingMode: 'static',
            tools: [{ name: 'tickets__search', raw_tool_name: 'search' }],
            authorizationRequired: false,
          },
        ],
      })
      expect(mocks.notifySkillsChanged).toHaveBeenCalled()
    })
    expect(
      mocks.request.mock.calls.find(call => call[0] === 'runtime.connectors.configure')?.[1]
    ).not.toHaveProperty('authToken')
  })

  test('syncs an unauthorized app as guidance-only so the agent can offer authorization', async () => {
    mocks.listCatalog.mockResolvedValue([
      {
        id: 1,
        slug: 'tickets',
        name: 'Tickets',
        description: '',
        icon_url: null,
        auth_type: 'oauth2',
        connection: { status: 'connected' },
      },
      {
        id: 2,
        slug: 'dingtalk_log',
        name: '钉钉日志',
        description: '工作日志',
        icon_url: null,
        auth_type: 'oauth2',
        connection: { status: 'disconnected' },
      },
    ])

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
        'runtime.connectors.apps.sync',
        expect.objectContaining({
          apps: expect.arrayContaining([
            expect.objectContaining({
              slug: 'dingtalk_log',
              tools: [],
              authorizationRequired: true,
            }),
          ]),
        })
      )
    })
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

  test('renews connector authorization without notifying unchanged capabilities', async () => {
    vi.useFakeTimers()
    let changed = true
    mocks.request.mockImplementation(() => Promise.resolve({ changed }))
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="cloud-token"
      />
    )

    try {
      await flushAsyncEffects()
      expect(mocks.notifySkillsChanged).toHaveBeenCalledTimes(1)

      changed = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1_000)
      })

      expect(mocks.issueToken).toHaveBeenCalledTimes(2)
      expect(mocks.listApps).toHaveBeenCalledTimes(2)
      expect(
        mocks.request.mock.calls.filter(([method]) => method === 'runtime.connectors.configure')
      ).toHaveLength(2)
      expect(
        mocks.request.mock.calls.filter(([method]) => method === 'runtime.connectors.apps.sync')
      ).toHaveLength(2)
      expect(mocks.notifySkillsChanged).toHaveBeenCalledTimes(1)

      changed = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1_000)
      })

      expect(mocks.issueToken).toHaveBeenCalledTimes(3)
      expect(mocks.notifySkillsChanged).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('keeps the connector expiry deadline through token issuance and slow synchronization', async () => {
    vi.useFakeTimers()
    const requestedAtMs = Date.now()
    const firstToken = deferred<{
      access_token: string
      token_type: string
      expires_in: number
    }>()
    const firstConfiguration = deferred<{ changed: boolean }>()
    const firstSynchronization = deferred<{ changed: boolean }>()
    let configurationCount = 0
    let synchronizationCount = 0
    mocks.issueToken.mockReturnValueOnce(firstToken.promise)
    mocks.request.mockImplementation((method: string) => {
      if (method === 'runtime.connectors.configure' && configurationCount++ === 0) {
        return firstConfiguration.promise
      }
      if (method === 'runtime.connectors.apps.sync' && synchronizationCount++ === 0) {
        return firstSynchronization.promise
      }
      return Promise.resolve({ changed: false })
    })
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="cloud-token"
      />
    )

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
        firstToken.resolve({
          access_token: 'scoped-connector-token',
          token_type: 'bearer',
          expires_in: 900,
        })
        await firstToken.promise
      })

      expect(mocks.request).toHaveBeenCalledWith(
        'runtime.connectors.configure',
        expect.objectContaining({ expiresAtMs: requestedAtMs + 900_000 })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
        firstConfiguration.resolve({ changed: false })
        await firstConfiguration.promise
      })
      await flushAsyncEffects()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000)
        firstSynchronization.resolve({ changed: true })
        await firstSynchronization.promise
      })
      expect(mocks.notifySkillsChanged).toHaveBeenCalledTimes(1)

      const remainingMs = requestedAtMs + 14 * 60 * 1_000 - Date.now()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(remainingMs - 1)
      })
      expect(mocks.issueToken).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(mocks.issueToken).toHaveBeenCalledTimes(2)
      expect(mocks.notifySkillsChanged).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('a superseded synchronization does not publish its catalog', async () => {
    vi.useFakeTimers()
    const firstSynchronization = deferred<{ changed: boolean }>()
    let synchronizationCount = 0
    mocks.request.mockImplementation((method: string) => {
      if (method === 'runtime.connectors.apps.sync' && synchronizationCount++ === 0) {
        return firstSynchronization.promise
      }
      return Promise.resolve({ changed: false })
    })
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="cloud-token"
      />
    )

    try {
      await flushAsyncEffects()
      expect(synchronizationCount).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1_000)
      })

      expect(mocks.issueToken).toHaveBeenCalledTimes(2)
      expect(
        mocks.request.mock.calls.filter(([method]) => method === 'runtime.connectors.configure')
      ).toHaveLength(2)
      expect(synchronizationCount).toBe(2)

      await act(async () => {
        firstSynchronization.resolve({ changed: true })
        await firstSynchronization.promise
      })
      // The renewal already owns the surface: a late result from the attempt
      // it replaced must not publish a catalog for an older attempt, and the
      // same rule is what keeps a signed-out account from being republished.
      expect(mocks.notifySkillsChanged).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test('does not replace a renewed connector timer when an older synchronization fails', async () => {
    vi.useFakeTimers()
    const firstSynchronization = deferred<{ changed: boolean }>()
    let synchronizationCount = 0
    mocks.request.mockImplementation((method: string) => {
      if (method === 'runtime.connectors.apps.sync' && synchronizationCount++ === 0) {
        return firstSynchronization.promise
      }
      return Promise.resolve({ changed: false })
    })
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="cloud-token"
      />
    )

    try {
      await flushAsyncEffects()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1_000)
      })
      expect(mocks.issueToken).toHaveBeenCalledTimes(2)

      await act(async () => {
        firstSynchronization.reject(new Error('superseded synchronization failed'))
        await firstSynchronization.promise.catch(() => undefined)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(mocks.issueToken).toHaveBeenCalledTimes(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1_000 - 30_000)
      })
      expect(mocks.issueToken).toHaveBeenCalledTimes(3)
      expect(mocks.notifySkillsChanged).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  test.each([
    { failedAtMs: 0, renewedAtMs: 30_000 },
    { failedAtMs: 830_000, renewedAtMs: 840_000 },
  ])(
    'retries synchronization failed at $failedAtMs without delaying renewal past $renewedAtMs',
    async ({ failedAtMs, renewedAtMs }) => {
      vi.useFakeTimers()
      const firstSynchronization = deferred<{ changed: boolean }>()
      const error = new Error('connector synchronization failed')
      const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let synchronizationCount = 0
      mocks.request.mockImplementation((method: string) => {
        if (method === 'runtime.connectors.apps.sync' && synchronizationCount++ === 0) {
          return firstSynchronization.promise
        }
        return Promise.resolve({ changed: false })
      })
      const view = render(
        <LocalExecutorCloudBridge
          preferencesLoaded
          apiBaseUrl="https://cloud.example.test/api"
          isConnected
          token="cloud-token"
        />
      )

      try {
        await flushAsyncEffects()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(failedAtMs)
          firstSynchronization.reject(error)
          await firstSynchronization.promise.catch(() => undefined)
        })
        expect(logError).toHaveBeenCalledWith(
          '[CloudConnection] Failed to synchronize connector authorization',
          error
        )

        await act(async () => {
          await vi.advanceTimersByTimeAsync(renewedAtMs - failedAtMs - 1)
        })
        expect(mocks.issueToken).toHaveBeenCalledTimes(1)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1)
        })
        expect(mocks.issueToken).toHaveBeenCalledTimes(2)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(14 * 60 * 1_000)
        })
        expect(mocks.issueToken).toHaveBeenCalledTimes(3)
        expect(mocks.notifySkillsChanged).not.toHaveBeenCalled()
      } finally {
        view.unmount()
        vi.useRealTimers()
        logError.mockRestore()
      }
    }
  )

  test('does not notify when disconnecting unchanged connector state', async () => {
    mocks.request.mockResolvedValue({ changed: false })

    render(<LocalExecutorCloudBridge preferencesLoaded isConnected={false} token={null} />)

    await flushAsyncEffects()

    expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.clear', {
      syncRevision: expect.any(Number),
    })
    expect(mocks.notifySkillsChanged).not.toHaveBeenCalled()
  })

  test('ignores a connector synchronization result after the bridge unmounts', async () => {
    const synchronization = deferred<{ changed: boolean }>()
    mocks.request.mockImplementation((method: string) =>
      method === 'runtime.connectors.apps.sync' ? synchronization.promise : Promise.resolve({})
    )
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="cloud-token"
      />
    )

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.apps.sync', expect.any(Object))
    )
    view.unmount()

    await act(async () => {
      synchronization.resolve({ changed: true })
      await synchronization.promise
    })

    expect(mocks.notifySkillsChanged).not.toHaveBeenCalled()
  })
  test('never reconfigures a signed-out account with a late token', async () => {
    const token = deferred<{ access_token: string; token_type: string; expires_in: number }>()
    mocks.issueToken.mockReturnValueOnce(token.promise)
    const view = render(
      <LocalExecutorCloudBridge
        preferencesLoaded
        apiBaseUrl="https://cloud.example.test/api"
        isConnected
        token="account-a-token"
      />
    )

    await waitFor(() => expect(mocks.issueToken).toHaveBeenCalledTimes(1))

    // Signing out clears the executor before the old token request returns.
    view.rerender(<LocalExecutorCloudBridge preferencesLoaded isConnected={false} token={null} />)
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('runtime.connectors.clear', {
        syncRevision: expect.any(Number),
      })
    )

    await act(async () => {
      token.resolve({ access_token: 'stale-account-token', token_type: 'bearer', expires_in: 900 })
      await token.promise
    })
    await flushAsyncEffects()

    expect(
      mocks.request.mock.calls.filter(([method]) => method === 'runtime.connectors.configure')
    ).toHaveLength(0)
    expect(
      mocks.request.mock.calls.filter(([method]) => method === 'runtime.connectors.apps.sync')
    ).toHaveLength(0)
  })
})
