import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices } from '@/api/local/localServices'
import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import {
  saveLocalProxyConfig,
  saveLocalProxyUrl,
} from '@/features/model-settings/localProxySettings'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureBundledPluginInstalled,
  withBundledPluginUpdatesPaused,
  resumeBundledPluginUpdates,
  ensureLocalExecutorAvailable,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  getBundledPluginUpdateState,
  getKnownLocalExecutorDeviceId,
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
    if (method === 'runtime.codex.plugin.reconcile_bundled_marketplace')
      return { marketplaceName: marketplace.id, action: 'unchanged' }
    if (method === 'runtime.codex.plugin.sync_bundled') return { status: 'ready', updated: false }
    return {}
  })
}

describe('localExecutor', () => {
  beforeEach(() => {
    localStorage.clear()
    delete window.weworkElectronNetwork
    resetLocalExecutorStateForTests()
    describeDshExecutorMock.mockReset()
    requestDshExecutorMock.mockReset()
    subscribeDshExecutorEventsMock.mockReset()
    subscribeDshExecutorEventsMock.mockReturnValue(() => undefined)
    mockStartup()
  })

  test('negotiates bounded transcript transport while accepting an older executor response', async () => {
    const transcript = { messages: [], turns: [], fullContent: false }
    requestDshExecutorMock.mockResolvedValue(transcript)
    expect(await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })).toBe(
      transcript
    )
    expect(requestDshExecutorMock).toHaveBeenCalledExactlyOnceWith('runtime.tasks.transcript', {
      taskId: 'task-1',
      transcriptProtocolVersion: 2,
    })
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
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
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
    await ensureBundledPluginInstalled('smart-app-builder')
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

  test('passes the system proxy into the startup barrier when no local proxy is configured', async () => {
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockResolvedValue('http://127.0.0.1:7891'),
    }

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: 'http://127.0.0.1:7891',
    })
  })

  test('passes no proxy into the startup barrier in direct mode', async () => {
    const resolveProxy = vi.fn().mockResolvedValue('http://127.0.0.1:7891')
    window.weworkElectronNetwork = { resolveProxy }
    saveLocalProxyConfig('direct')

    await ensureLocalExecutorStarted()

    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.runtime_config.update', {
      proxyUrl: null,
    })
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  test('reuses the initialized executor status for repeated startup checks', async () => {
    const first = await ensureLocalExecutorStarted()

    await expect(getLocalExecutorStatus()).resolves.toEqual(first)

    expect(describeDshExecutorMock).toHaveBeenCalledOnce()
    // Startup also reconciles the bundled marketplace into Codex (local RPC).
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(1)
  })

  test('invalidates the initialized status after an executor request failure', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
    requestDshExecutorMock.mockRejectedValueOnce(new Error('executor unavailable'))

    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow('executor unavailable')
    mockStartup()
    await ensureLocalExecutorStarted()

    expect(describeDshExecutorMock).toHaveBeenCalledTimes(2)
  })

  test('keeps the initialized status after an executor business error', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
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
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.ensure_started'
      )
    ).toHaveLength(1)
  })

  test('retains validated installation identity while disconnected and replaces it on reconnect', async () => {
    const services = createLocalAppServices({ subscribe: () => () => undefined })
    await services.deviceApi.listDevices()
    const disconnected = new DshExecutorTransportError(
      'executor_disconnected',
      'IPC disconnected',
      true
    )
    requestDshExecutorMock.mockRejectedValueOnce(disconnected)
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow('IPC disconnected')
    describeDshExecutorMock.mockRejectedValueOnce(disconnected)

    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: false,
      ready: false,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      error: 'IPC disconnected',
    })
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
    describeDshExecutorMock.mockRejectedValueOnce(disconnected)
    await expect(services.deviceApi.listDevices()).resolves.toEqual([
      expect.objectContaining({
        status: 'offline',
        device_id: 'electron-device',
        runtime_instance_id: 'electron-runtime',
      }),
    ])
    describeDshExecutorMock.mockResolvedValueOnce({
      protocol_version: 1,
      device_id: 'electron-device',
      runtime_instance_id: 'replacement-runtime',
      capabilities: [],
      renderer_methods: [],
      transports: [],
    })
    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: true,
      runtimeInstanceId: 'replacement-runtime',
    })
  })

  test('revokes cached installation identity when the IPC protocol is invalid', async () => {
    await ensureLocalExecutorAvailable()
    const mismatch = new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    requestDshExecutorMock.mockRejectedValueOnce(mismatch)
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    describeDshExecutorMock.mockRejectedValueOnce(mismatch)

    await expect(getLocalExecutorStatus()).rejects.toThrow('Invalid Runtime identity')
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
  })

  test('a pending description cannot restore identity revoked by a protocol error', async () => {
    const originalDescription = await describeDshExecutorMock()
    await ensureLocalExecutorAvailable()
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError('transport_disconnected', 'Executor disconnected', true)
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Executor disconnected'
    )
    let finish!: (value: typeof originalDescription) => void
    describeDshExecutorMock.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const pendingStatus = getLocalExecutorStatus()
    requestDshExecutorMock.mockRejectedValueOnce(
      new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    expect(getKnownLocalExecutorDeviceId()).toBeNull()

    const rejectedStatus = expect(pendingStatus).rejects.toMatchObject({
      code: 'protocol_mismatch',
    })
    finish(originalDescription)
    await rejectedStatus
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
    await expect(getLocalExecutorStatus()).resolves.toMatchObject({
      running: true,
      runtimeInstanceId: 'electron-runtime',
    })
  })

  test('synchronizes declared bundled plugins even when already configured', async () => {
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(requestDshExecutorMock).toHaveBeenCalledWith('runtime.codex.plugin.sync_bundled', {
      marketplacePath: `${marketplace.path}/.agents/plugins/marketplace.json`,
      pluginName: 'smart-app-builder',
    })
    expect(getBundledPluginUpdateState('smart-app-builder')).toEqual({ status: 'ready' })
  })

  test('startup becomes ready while bundled marketplace initialization is pending', async () => {
    let finish!: (value: typeof marketplace) => void
    const pending = new Promise<typeof marketplace>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'executor.plugins.initialize_bundled_marketplace'
        ? pending
        : original(method, params)
    )
    await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({ ready: true })
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
    finish(marketplace)
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
  })

  test('concurrent uses share one pending plugin update', async () => {
    let finish!: (value: { status: 'ready'; updated: boolean }) => void
    const pending = new Promise<{ status: 'ready'; updated: boolean }>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
    )
    const first = ensureBundledPluginInstalled('smart-app-builder')
    const second = ensureBundledPluginInstalled('smart-app-builder')
    await vi.waitFor(() =>
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
    )
    finish({ status: 'ready', updated: true })
    await Promise.all([first, second])
    expect(
      requestDshExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.codex.plugin.sync_bundled'
      )
    ).toHaveLength(1)
  })

  test('busy updates defer usage and resume only after work finishes', async () => {
    vi.useFakeTimers()
    try {
      let busy = true
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled'
          ? Promise.resolve({ status: busy ? 'deferred' : 'ready', updated: !busy })
          : original(method, params)
      )
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_update_deferred',
      })
      busy = false
      await vi.advanceTimersByTimeAsync(2_000)
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test('uninstall cancels deferred retries until an explicit reinstall', async () => {
    vi.useFakeTimers()
    try {
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled'
          ? Promise.resolve({ status: 'deferred', updated: false })
          : original(method, params)
      )
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_update_deferred',
      })
      const uninstall = vi.fn().mockResolvedValue(undefined)
      await withBundledPluginUpdatesPaused('smart-app-builder', uninstall)
      const syncCount = requestDshExecutorMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(6_000)
      expect(requestDshExecutorMock.mock.calls).toHaveLength(syncCount)
      expect(getBundledPluginUpdateState('smart-app-builder')).toBeUndefined()
      await expect(ensureBundledPluginInstalled('smart-app-builder')).rejects.toMatchObject({
        code: 'bundled_plugin_uninstalled',
      })
      resumeBundledPluginUpdates('smart-app-builder')
      mockStartup()
      await ensureBundledPluginInstalled('smart-app-builder')
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test.each(['ready', 'deferred'] as const)(
    'uninstall waits for an in-flight %s result and ignores its state',
    async status => {
      let finish!: (result: { status: typeof status; updated: boolean }) => void
      const pending = new Promise<{ status: typeof status; updated: boolean }>(resolve => {
        finish = resolve
      })
      const original = requestDshExecutorMock.getMockImplementation()!
      requestDshExecutorMock.mockImplementation((method, params) =>
        method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
      )
      const use = ensureBundledPluginInstalled('smart-app-builder')
      const rejectedUse = expect(use).rejects.toMatchObject({ code: 'bundled_plugin_uninstalled' })
      await vi.waitFor(() =>
        expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
      )
      const uninstall = vi.fn().mockResolvedValue(undefined)
      const completion = withBundledPluginUpdatesPaused('smart-app-builder', uninstall)
      expect(uninstall).not.toHaveBeenCalled()
      finish({ status, updated: status === 'ready' })
      await completion
      await rejectedUse
      expect(uninstall).toHaveBeenCalledOnce()
      expect(getBundledPluginUpdateState('smart-app-builder')).toBeUndefined()
    }
  )

  test('failed uninstall restores deferred upgrade recovery', async () => {
    vi.useFakeTimers()
    try {
      await ensureBundledPluginInstalled('smart-app-builder')
      await expect(
        withBundledPluginUpdatesPaused('smart-app-builder', async () => {
          throw new Error('uninstall failed')
        })
      ).rejects.toThrow('uninstall failed')
      await vi.advanceTimersByTimeAsync(2_000)
      await ensureBundledPluginInstalled('smart-app-builder')
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed plugin does not block other default plugins', async () => {
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) => {
      if (method === 'executor.plugins.initialize_bundled_marketplace')
        return Promise.resolve({
          ...marketplace,
          defaultPluginNames: ['smart-app-builder', 'wework-space'],
        })
      if (
        method === 'runtime.codex.plugin.sync_bundled' &&
        (params as { pluginName: string }).pluginName === 'wework-space'
      )
        return Promise.reject(
          new DshExecutorTransportError('bundled_plugin_update_failed', 'cache locked')
        )
      return original(method, params)
    })
    await ensureBundledPluginInstalled('smart-app-builder')
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
    expect(getBundledPluginUpdateState('wework-space')?.status).toBe('failed')
  })

  test('a previous runtime update cannot overwrite a new runtime state', async () => {
    let finish!: (result: { status: 'deferred'; updated: boolean }) => void
    const pending = new Promise<{ status: 'deferred'; updated: boolean }>(resolve => {
      finish = resolve
    })
    const original = requestDshExecutorMock.getMockImplementation()!
    requestDshExecutorMock.mockImplementation((method, params) =>
      method === 'runtime.codex.plugin.sync_bundled' ? pending : original(method, params)
    )
    const oldUse = ensureBundledPluginInstalled('smart-app-builder')
    await vi.waitFor(() =>
      expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('updating')
    )
    resetLocalExecutorStateForTests()
    mockStartup()
    await ensureBundledPluginInstalled('smart-app-builder')
    finish({ status: 'deferred', updated: false })
    await oldUse
    expect(getBundledPluginUpdateState('smart-app-builder')?.status).toBe('ready')
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
