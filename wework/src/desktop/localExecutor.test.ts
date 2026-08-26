import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureBundledPluginInstalled,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  getLocalExecutorStatus,
  requestLocalExecutor,
  resetLocalExecutorStateForTests,
  subscribeLocalExecutorEvents,
} from './localExecutor'

vi.mock('@/api/dsh/executorTransport', () => ({
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

  test('performs a fresh DSH health check for status requests', async () => {
    const first = await ensureLocalExecutorStarted()

    await expect(getLocalExecutorStatus()).resolves.toEqual(first)

    expect(describeDshExecutorMock).toHaveBeenCalledTimes(2)
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

  test('configures and clears the backend connection through DSH', async () => {
    await connectLocalExecutorToBackend({
      backendUrl: 'https://api.example.com',
      socketBaseUrl: 'wss://api.example.com',
      authToken: 'token',
      runtimeAuthToken: 'runtime-token',
    })
    resetLocalExecutorStateForTests()
    mockStartup()
    await disconnectLocalExecutorFromBackend()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('executor.backend.configure', {
      backend_url: 'https://api.example.com',
      socket_url: 'wss://api.example.com',
      auth_token: 'token',
      runtime_auth_token: 'runtime-token',
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
