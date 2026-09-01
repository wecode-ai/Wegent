import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureBundledPluginInstalled,
  ensureLocalExecutorAvailable,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  getLocalExecutorStatus,
  readLocalExecutorLog,
  requestLocalExecutor,
  resetLocalExecutorStateForTests,
  subscribeLocalExecutorEvents,
} from './localExecutor'

vi.mock('@/api/dsh/executorTransport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/executorTransport')>()),
  describeDshExecutor: vi.fn(),
  requestDshExecutor: vi.fn(),
  subscribeDshExecutorEvents: vi.fn(),
}))

const describeDshExecutorMock = vi.mocked(describeDshExecutor)
const requestDshExecutorMock = vi.mocked(requestDshExecutor)
const subscribeDshExecutorEventsMock = vi.mocked(subscribeDshExecutorEvents)

const marketplace = {
  id: 'wework-personal',
  path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
  pluginCount: 1,
  defaultPluginNames: ['smart-app-builder'],
  contentHash: 'abc123',
}

function mockStartup(): void {
  describeDshExecutorMock.mockResolvedValue({
    protocol_version: 1,
    device_id: 'electron-device',
    runtime_instance_id: 'electron-runtime',
    version: '1.8.6',
    capabilities: ['executor.plugins'],
    renderer_methods: ['runtime.*'],
    transports: ['local-endpoint-ndjson'],
  })
  requestDshExecutorMock.mockImplementation(async method => {
    if (method === 'runtime.codex.ensure_started') {
      return { ready: true, started: true, initializeElapsedMs: 37 }
    }
    if (method === 'executor.plugins.initialize_bundled_marketplace') return marketplace
    return {}
  })
}

describe('localExecutor', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLocalExecutorStateForTests()
    describeDshExecutorMock.mockReset()
    requestDshExecutorMock.mockReset()
    subscribeDshExecutorEventsMock.mockReset()
    mockStartup()
  })

  test('reports executor availability without starting Codex or copying plugins', async () => {
    await expect(ensureLocalExecutorAvailable()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      version: '1.8.6',
    })

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    expect(requestDshExecutorMock).not.toHaveBeenCalled()
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
  })

  test('starts the Electron-managed DSH executor and caches its marketplace', async () => {
    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      codexInitializeElapsedMs: 37,
      version: '1.8.6',
    })
    expect(getInitializedBundledPluginMarketplace()).toEqual(marketplace)
    expect(requestDshExecutorMock.mock.calls.slice(0, 3)).toEqual([
      ['runtime.codex.runtime_config.update', { proxyUrl: null }],
      ['runtime.codex.ensure_started'],
      ['executor.plugins.initialize_bundled_marketplace'],
    ])
  })

  test('passes the configured proxy into the startup barrier', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: 'http://127.0.0.1:7890',
    })
  })

  test('reuses the initialized executor status for repeated startup checks', async () => {
    const first = await ensureLocalExecutorStarted()

    await expect(getLocalExecutorStatus()).resolves.toEqual(first)

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    expect(requestDshExecutorMock).toHaveBeenCalledTimes(3)
  })

  test('invalidates the initialized status after an executor request failure', async () => {
    await ensureLocalExecutorStarted()
    requestDshExecutorMock.mockRejectedValueOnce(new Error('executor unavailable'))

    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow('executor unavailable')
    mockStartup()
    await ensureLocalExecutorStarted()

    expect(describeDshExecutorMock).toHaveBeenCalledTimes(2)
  })

  test('keeps the initialized status after an executor business error', async () => {
    await ensureLocalExecutorStarted()
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError(
        'connector_cloud_disconnected',
        'Connect Wework to Wegent cloud before synchronizing apps'
      )
    )

    await expect(requestLocalExecutor('runtime.connectors.apps.sync')).rejects.toThrow(
      'Connect Wework to Wegent cloud'
    )
    await ensureLocalExecutorStarted()

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    expect(requestDshExecutorMock).toHaveBeenCalledTimes(4)
  })

  test('installs a declared bundled plugin through Codex app-server', async () => {
    requestDshExecutorMock.mockImplementation(async (method, params) => {
      if (method === 'runtime.codex.ensure_started') {
        return { ready: true, started: true, initializeElapsedMs: 37 }
      }
      if (method === 'executor.plugins.initialize_bundled_marketplace') return marketplace
      if (method !== 'codex.app_server_request') return {}
      const request = params as { method?: string }
      if (request.method === 'marketplace/add') return { marketplaceName: marketplace.id }
      if (request.method === 'config/read') return { config: { plugins: {} } }
      if (request.method === 'plugin/install') return {}
      throw new Error(`Unexpected request: ${request.method}`)
    })

    await ensureBundledPluginInstalled('smart-app-builder')

    expect(requestDshExecutorMock).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'plugin/install',
      params: {
        marketplacePath: `${marketplace.path}/.agents/plugins/marketplace.json`,
        remoteMarketplaceName: null,
        pluginName: 'smart-app-builder',
      },
    })
  })

  test('rejects a plugin that is not installed by default', async () => {
    await expect(ensureBundledPluginInstalled('unknown')).rejects.toThrow(
      'Bundled plugin unknown is not installed by default'
    )
  })

  test('routes executor requests through DSH', async () => {
    requestDshExecutorMock.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })

    await expect(requestLocalExecutor('runtime.tasks.list')).resolves.toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('reports the configured backend connection from DSH', async () => {
    requestDshExecutorMock.mockResolvedValue({
      configured: true,
      connected: true,
      backend_url: 'https://api.example.com',
      socket_url: 'wss://socket.example.com',
    })

    await expect(readLocalExecutorLog()).resolves.toMatchObject({
      backendUrl: 'https://api.example.com',
      socketUrl: 'wss://socket.example.com',
      hasBackendAuthToken: true,
    })

    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.status', {})
  })

  test('configures and clears the backend connection through DSH', async () => {
    await connectLocalExecutorToBackend({
      backendUrl: 'https://api.example.com',
      socketBaseUrl: 'wss://api.example.com',
      authToken: 'token',
      runtimeAuthToken: 'runtime-token',
      deviceType: 'remote',
    })
    resetLocalExecutorStateForTests()
    mockStartup()
    await disconnectLocalExecutorFromBackend()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.configure', {
      backend_url: 'https://api.example.com',
      socket_url: 'wss://api.example.com',
      auth_token: 'token',
      runtime_auth_token: 'runtime-token',
      device_type: 'remote',
    })
    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.configure', {})
  })

  test('forwards DSH executor events and disposes the subscription', async () => {
    const dispose = vi.fn()
    let listener: ((event: { event: string; payload: Record<string, unknown> }) => void) | null =
      null
    subscribeDshExecutorEventsMock.mockImplementation(callback => {
      listener = callback
      return dispose
    })
    const handler = vi.fn()

    const unlisten = await subscribeLocalExecutorEvents(handler)
    listener?.({ event: 'runtime.updated', payload: { taskId: 'task-1' } })

    expect(handler).toHaveBeenCalledWith({
      event: 'runtime.updated',
      payload: { taskId: 'task-1' },
    })
    unlisten()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
