import { usePluginRefreshReconciliation } from '@/components/plugins/hooks/usePluginRefreshReconciliation'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  PLUGIN_RELEASE_AVAILABLE_EVENT,
  PluginAutoUpdateCoordinator,
} from './PluginAutoUpdateCoordinator'
import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
  hasInFlightPluginDeviceSync,
} from './pluginDeviceAutoSync'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>()
  return {
    handlers,
    ensureConnected: vi.fn(async () => undefined),
    dispose: vi.fn(),
    socketOn: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      const eventHandlers = handlers.get(event) ?? new Set()
      eventHandlers.add(handler)
      handlers.set(event, eventHandlers)
    }),
    socketOff: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      handlers.get(event)?.delete(handler)
    }),
    listLocalInstalledPlugins: vi.fn(async () => ({ items: [], deviceId: 'device-1' })),
    listMarketplacePlugins: vi.fn(async () => ({ items: [] })),
    autoUpdateInstalledPlugins: vi.fn(),
    syncInstalledPluginToDevice: vi.fn(),
    syncInstalledPluginsToDevice: vi.fn(),
    clearLocalCache: vi.fn(),
    notifyLocalPluginSkillsChanged: vi.fn(),
    track: vi.fn(),
    runtimeConnected: true,
    routeId: 'device-1',
    requestLocalExecutor: vi.fn(),
    token: 'cloud-token',
    httpOptions: null as { signal?: AbortSignal } | null,
  }
})

vi.mock('@wegent/chat-core', () => ({
  createSocketClient: vi.fn(() => ({
    ensureConnected: mocks.ensureConnected,
    dispose: mocks.dispose,
    socket: {
      on: mocks.socketOn,
      off: mocks.socketOff,
    },
  })),
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({
    isConnected: true,
    apiBaseUrl: 'https://cloud.example.com/api',
    socketBaseUrl: 'https://cloud.example.com',
    socketPath: '/socket.io',
    token: mocks.token,
  }),
}))

vi.mock('@/features/cloud-connection/localExecutorCloudConnectionStatus', () => ({
  useLocalExecutorCloudConnectionStatus: () => ({
    apiBaseUrl: 'https://cloud.example.com/api',
    connected: mocks.runtimeConnected,
  }),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  clearLocalCodexPluginsReadStateCache: mocks.clearLocalCache,
  createLocalCodexPluginApi: () => ({
    listInstalledPlugins: mocks.listLocalInstalledPlugins,
  }),
}))

vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: mocks.requestLocalExecutor,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(options => {
    mocks.httpOptions = options
    return {}
  }),
}))
vi.mock('@/api/plugins', () => ({
  createPluginApi: () => ({
    listMarketplacePlugins: mocks.listMarketplacePlugins,
    autoUpdateInstalledPlugins: mocks.autoUpdateInstalledPlugins,
    syncInstalledPluginToDevice: mocks.syncInstalledPluginToDevice,
    syncInstalledPluginsToDevice: mocks.syncInstalledPluginsToDevice,
  }),
}))
vi.mock('@/features/plugins/pluginTrial', () => ({
  notifyLocalPluginSkillsChanged: mocks.notifyLocalPluginSkillsChanged,
}))
vi.mock('@/features/idle-tasks/idleTaskScheduler', () => ({
  scheduleIdleTask: vi.fn((_id: string, task: () => Promise<void>) => {
    void task()
    return vi.fn()
  }),
}))
vi.mock('@/telemetry/businessEvents', () => ({ trackPluginEvent: mocks.track }))

function emit(event: string, payload?: unknown) {
  for (const handler of mocks.handlers.get(event) ?? []) handler(payload)
}

describe('PluginAutoUpdateCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.runtimeConnected = true
    mocks.routeId = 'device-1'
    mocks.listMarketplacePlugins.mockResolvedValue({ items: [] })
    mocks.requestLocalExecutor.mockImplementation(async (_method, params) => ({
      device_id: params.device_id,
      device_route_id: mocks.routeId,
    }))
    mocks.token = 'cloud-token'
    clearPluginDeviceAutoSyncAttempts()
    mocks.autoUpdateInstalledPlugins.mockResolvedValue({
      updated: [
        {
          installedPluginId: 1,
          pluginId: 2,
          fromReleaseId: 3,
          toReleaseId: 4,
          version: '2.0.0',
        },
      ],
      updatedCount: 1,
      remainingCount: 0,
    })
    mocks.syncInstalledPluginsToDevice.mockResolvedValue({
      deviceId: 'device-1',
      pendingCount: 0,
      sync: {
        success: true,
        device_id: 'device-1',
        mode: 'replace',
        skills: [],
        plugins: [],
        mcps: [],
        errors: [],
        synced: 1,
        failed: 0,
        skipped: 0,
        results: [],
      },
    })
    mocks.syncInstalledPluginToDevice.mockResolvedValue({
      deviceId: 'device-1',
      pendingCount: 0,
      sync: {
        success: true,
        device_id: 'device-1',
        mode: 'merge',
        skills: [],
        plugins: [{ id: 1, name: 'plugin-1', status: 'synced' }],
        mcps: [],
        errors: [],
        synced: 1,
        failed: 0,
        skipped: 0,
        results: [],
      },
    })
  })

  test('uses the registered route for background release sync and discovery', async () => {
    mocks.routeId = 'app-record-73'
    render(<PluginAutoUpdateCoordinator />)

    await waitFor(() => expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledOnce())
    expect(mocks.listMarketplacePlugins).toHaveBeenCalledWith({ deviceId: mocks.routeId })
    expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledWith(1, mocks.routeId)
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.device_route', {
      backend_url: 'https://cloud.example.com',
      auth_token: 'cloud-token',
      device_id: 'device-1',
    })
    expect(mocks.syncInstalledPluginsToDevice).not.toHaveBeenCalled()
    expect(hasInFlightPluginDeviceSync('device-1')).toBe(false)
  })

  test('queries confirmed membership on the registered route without a redundant full sync', async () => {
    mocks.routeId = 'app-record-73'
    mocks.autoUpdateInstalledPlugins.mockResolvedValue({
      updated: [],
      updatedCount: 0,
      remainingCount: 0,
    })
    mocks.listMarketplacePlugins.mockImplementation(async ({ deviceId }) => ({
      items: [
        {
          installed: true,
          installedLocally: deviceId === mocks.routeId,
          installedPluginId: 1,
          currentDeviceInstallation:
            deviceId === mocks.routeId
              ? { deviceId, state: 'installed', actualReleaseId: 4, desiredReleaseId: 4 }
              : null,
        },
      ],
    }))
    render(<PluginAutoUpdateCoordinator />)

    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledOnce())
    await waitFor(() => expect(hasInFlightPluginDeviceSync('device-1')).toBe(false))
    expect(mocks.listMarketplacePlugins).toHaveBeenCalledWith({ deviceId: mocks.routeId })
    expect(mocks.syncInstalledPluginsToDevice).not.toHaveBeenCalled()
    expect(mocks.syncInstalledPluginToDevice).not.toHaveBeenCalled()
  })

  test('retains a release notification while a policy save holds the shared device lock', async () => {
    const finishPolicySave = beginPluginDeviceSync('device-1')!
    render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.listLocalInstalledPlugins).toHaveBeenCalled())
    await act(async () => emit(PLUGIN_RELEASE_AVAILABLE_EVENT, { releaseId: 4 }))
    expect(mocks.autoUpdateInstalledPlugins).not.toHaveBeenCalled()

    await act(async () => finishPolicySave())

    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledTimes(2))
  })

  test('cancels a blocked update check when its coordinator unmounts', async () => {
    const finishPolicySave = beginPluginDeviceSync('device-1')!
    const view = render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.listLocalInstalledPlugins).toHaveBeenCalled())

    view.unmount()
    await act(async () => finishPolicySave())

    expect(mocks.autoUpdateInstalledPlugins).not.toHaveBeenCalled()
    expect(hasInFlightPluginDeviceSync('device-1')).toBe(false)
  })

  test('keeps an accepted device sync locked across runtime disconnect and reconnect', async () => {
    mocks.autoUpdateInstalledPlugins
      .mockImplementationOnce(mocks.autoUpdateInstalledPlugins.getMockImplementation()!)
      .mockResolvedValueOnce({ updated: [], updatedCount: 0, remainingCount: 0 })
    let finishSync!: () => void
    mocks.syncInstalledPluginToDevice.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishSync = () =>
            resolve({
              deviceId: 'device-1',
              pendingCount: 0,
              sync: { success: true, plugins: [{ id: 1, status: 'synced' }], errors: [] },
            })
          mocks.httpOptions?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Request cancelled', 'AbortError'))
          )
        })
    )
    const view = render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledOnce())
    const signal = mocks.httpOptions?.signal

    mocks.runtimeConnected = false
    view.rerender(<PluginAutoUpdateCoordinator />)
    await act(async () => {})
    expect(signal?.aborted).toBe(false)
    expect(hasInFlightPluginDeviceSync('device-1')).toBe(true)

    mocks.runtimeConnected = true
    view.rerender(<PluginAutoUpdateCoordinator />)
    await act(async () => {})
    expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledOnce()
    expect(hasInFlightPluginDeviceSync('device-1')).toBe(true)

    await act(async () => finishSync())
    await waitFor(() => expect(hasInFlightPluginDeviceSync('device-1')).toBe(false))
    expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledTimes(2)
    expect(mocks.clearLocalCache).not.toHaveBeenCalled()
    expect(mocks.notifyLocalPluginSkillsChanged).not.toHaveBeenCalled()
  })

  test('lets the returned account reconcile while the previous account sync awaits its lost ACK', async () => {
    mocks.autoUpdateInstalledPlugins.mockResolvedValue({
      updated: [],
      updatedCount: 0,
      remainingCount: 0,
    })
    mocks.listMarketplacePlugins.mockResolvedValue({ items: [] }).mockResolvedValueOnce({
      items: [
        {
          installedPluginId: 1,
          installed: true,
          installedLocally: false,
          currentDeviceInstallation: { state: 'pending' },
        },
      ],
    })
    let finishOldSync!: () => void
    mocks.syncInstalledPluginsToDevice.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishOldSync = () =>
            resolve({
              deviceId: 'device-1',
              pendingCount: 0,
              sync: { success: true, plugins: [], errors: [] },
            })
          mocks.httpOptions?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Account changed', 'AbortError'))
          )
        })
    )
    const collision = new Error('PLUGIN_RUNTIME_METADATA_FAILED')
    const manualSync = vi.fn(async () => {
      throw collision
    })
    const onError = vi.fn()
    const initial = {
      request: 0,
      accountKey: 'recipient',
      deviceId: 'device-1',
      available: true,
      busy: false,
      operations: {
        readStore: vi.fn(async () => []),
        sync: manualSync,
        readCloud: vi.fn(async () => []),
        invalidate: vi.fn(),
      },
      onComplete: vi.fn(),
      onError,
    }
    const manual = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
    const view = render(<PluginAutoUpdateCoordinator />)
    try {
      await waitFor(() => expect(mocks.syncInstalledPluginsToDevice).toHaveBeenCalledOnce())
      expect(hasInFlightPluginDeviceSync('device-1')).toBe(true)
      mocks.token = 'returned-author-token'
      view.rerender(<PluginAutoUpdateCoordinator />)
      manual.rerender({ ...initial, request: 1, accountKey: 'author' })

      await waitFor(() => expect(onError).toHaveBeenCalledWith(collision))
      expect(manualSync).toHaveBeenCalledOnce()
      expect(mocks.clearLocalCache).not.toHaveBeenCalled()
      expect(mocks.notifyLocalPluginSkillsChanged).not.toHaveBeenCalled()
    } finally {
      manual.unmount()
      view.unmount()
      await act(async () => finishOldSync?.())
    }
  })

  test('releases an old account pending sync on account change without publishing stale results', async () => {
    mocks.autoUpdateInstalledPlugins
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            mocks.httpOptions?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Account changed', 'AbortError'))
            )
          })
      )
      .mockResolvedValueOnce({ updated: [], updatedCount: 0, remainingCount: 0 })
    const view = render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledOnce())
    expect(hasInFlightPluginDeviceSync('device-1')).toBe(true)
    const previousSignal = mocks.httpOptions?.signal

    mocks.token = 'next-account-token'
    view.rerender(<PluginAutoUpdateCoordinator />)

    expect(previousSignal?.aborted).toBe(true)
    await waitFor(() => expect(hasInFlightPluginDeviceSync('device-1')).toBe(false))
    expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledTimes(2)
    expect(mocks.syncInstalledPluginToDevice).not.toHaveBeenCalled()
    expect(mocks.clearLocalCache).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })

  test('does not publish a sync response that settled after its account disconnected', async () => {
    let finishSync!: () => void
    const response = {
      deviceId: 'device-1',
      pendingCount: 0,
      sync: { success: true, plugins: [{ id: 1, status: 'synced' }], errors: [] },
    }
    mocks.syncInstalledPluginToDevice.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSync = () => resolve(response)
        })
    )
    const view = render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledOnce())

    view.unmount()
    await act(async () => finishSync())

    expect(hasInFlightPluginDeviceSync('device-1')).toBe(false)
    expect(mocks.clearLocalCache).not.toHaveBeenCalled()
    expect(mocks.notifyLocalPluginSkillsChanged).not.toHaveBeenCalled()
  })

  test('checks on startup and when a published release event arrives', async () => {
    render(<PluginAutoUpdateCoordinator />)

    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledOnce())
    expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledWith(1, 'device-1')
    expect(mocks.syncInstalledPluginsToDevice).not.toHaveBeenCalled()
    expect(mocks.clearLocalCache).toHaveBeenCalledOnce()
    expect(mocks.notifyLocalPluginSkillsChanged).toHaveBeenCalledOnce()

    await act(async () => {
      emit(PLUGIN_RELEASE_AVAILABLE_EVENT, {
        pluginId: 2,
        releaseId: 5,
        version: '2.1.0',
      })
    })

    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledTimes(2))
  })

  test('drains a retryable device failure through the existing failure limit path', async () => {
    mocks.autoUpdateInstalledPlugins
      .mockResolvedValueOnce({
        updated: [
          {
            installedPluginId: 1,
            pluginId: 2,
            fromReleaseId: 3,
            toReleaseId: 4,
            version: '2.0.0',
          },
        ],
        updatedCount: 1,
        remainingCount: 0,
      })
      .mockResolvedValue({ updated: [], updatedCount: 0, remainingCount: 0 })
    mocks.listMarketplacePlugins.mockResolvedValueOnce({ items: [] }).mockResolvedValue({
      items: [
        {
          installedPluginId: 1,
          installed: true,
          installedLocally: true,
          updateAvailable: false,
          currentDeviceInstallation: {
            deviceId: 'device-1',
            desiredReleaseId: 4,
            actualReleaseId: 3,
            state: 'failed',
            errorCode: 'PLUGIN_DOWNLOAD_FAILED',
            errorMessage: 'download failed',
            attemptCount: 1,
            lastSyncAt: null,
            updatedAt: '2026-09-24T00:00:00Z',
          },
        },
      ],
    })
    mocks.syncInstalledPluginToDevice.mockResolvedValueOnce({
      deviceId: 'device-1',
      pendingCount: 1,
      sync: {
        success: false,
        device_id: 'device-1',
        mode: 'merge',
        skills: [],
        plugins: [
          {
            id: 1,
            name: 'plugin-1',
            status: 'failed',
            stage: 'download',
            error_code: 'PLUGIN_DOWNLOAD_FAILED',
            retryable: true,
            error: 'download failed',
          },
        ],
        mcps: [],
        errors: [],
        synced: 0,
        failed: 1,
        skipped: 0,
        results: [],
      },
    })

    render(<PluginAutoUpdateCoordinator />)

    await waitFor(() => expect(mocks.autoUpdateInstalledPlugins).toHaveBeenCalledTimes(2))
    expect(mocks.syncInstalledPluginToDevice).toHaveBeenCalledOnce()
    expect(mocks.syncInstalledPluginsToDevice).toHaveBeenCalledWith('device-1', false)
    expect(mocks.track).toHaveBeenCalledWith('operation_failed', {
      operation: 'plugin_auto_update',
    })
  })

  test('removes socket handlers and disconnects its notification client on unmount', async () => {
    const view = render(<PluginAutoUpdateCoordinator />)
    await waitFor(() => expect(mocks.ensureConnected).toHaveBeenCalledOnce())

    view.unmount()

    expect(mocks.socketOff).toHaveBeenCalledWith('connect', expect.any(Function))
    expect(mocks.socketOff).toHaveBeenCalledWith(
      PLUGIN_RELEASE_AVAILABLE_EVENT,
      expect.any(Function)
    )
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })
})
