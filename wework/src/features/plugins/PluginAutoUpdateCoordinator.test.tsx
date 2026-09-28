import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { clearPluginDeviceAutoSyncAttempts } from './pluginDeviceAutoSync'
import {
  PLUGIN_RELEASE_AVAILABLE_EVENT,
  PluginAutoUpdateCoordinator,
} from './PluginAutoUpdateCoordinator'

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
    token: 'cloud-token',
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

vi.mock('@/api/http', () => ({ createHttpClient: vi.fn(() => ({})) }))
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
    expect(mocks.syncInstalledPluginsToDevice).toHaveBeenCalledWith('device-1')
    expect(mocks.track).toHaveBeenCalledWith('operation_failed', {
      operation: 'plugin_auto_update',
    })
  })

  test('waits until the local executor has connected to the cloud backend', () => {
    mocks.runtimeConnected = false
    render(<PluginAutoUpdateCoordinator />)

    expect(mocks.ensureConnected).not.toHaveBeenCalled()
    expect(mocks.autoUpdateInstalledPlugins).not.toHaveBeenCalled()
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
