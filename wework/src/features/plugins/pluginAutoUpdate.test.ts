import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  PluginAutoUpdateBatchResponse,
  PluginDeviceSyncResponse,
  PluginMarketplaceItem,
} from '@/types/api'
import {
  marketplaceItemCanRetryPluginUpdate,
  marketplaceItemHasPausedPluginAutoUpdate,
  marketplaceItemNeedsPluginAutoUpdate,
  runCurrentDevicePluginAutoUpdate,
  runPluginAutoUpdate,
} from './pluginAutoUpdate'
import { clearPluginDeviceAutoSyncAttempts } from './pluginDeviceAutoSync'

function batch(
  updatedCount: number,
  remainingCount: number,
  startId = 1
): PluginAutoUpdateBatchResponse {
  return {
    updated: Array.from({ length: updatedCount }, (_, index) => ({
      installedPluginId: startId + index,
      pluginId: index + 101,
      fromReleaseId: index + 201,
      toReleaseId: index + 301,
      version: '2.0.0',
    })),
    updatedCount,
    remainingCount,
  }
}

function sync(success: boolean, installedPluginId = 1): PluginDeviceSyncResponse {
  return {
    deviceId: 'device-1',
    pendingCount: 0,
    sync: {
      success,
      device_id: 'device-1',
      mode: 'replace',
      skills: [],
      plugins: [
        success
          ? { id: installedPluginId, name: `plugin-${installedPluginId}`, status: 'synced' }
          : {
              id: installedPluginId,
              name: `plugin-${installedPluginId}`,
              status: 'failed',
              stage: 'codex_config',
              error_code: 'INVALID_CODEX_CONFIG',
              retryable: false,
              error: 'Invalid Codex config',
            },
      ],
      mcps: [],
      errors: success ? [] : [{ error: 'sync failed' }],
      synced: success ? 1 : 0,
      failed: success ? 0 : 1,
      skipped: 0,
      results: [],
    },
  }
}

describe('runPluginAutoUpdate', () => {
  beforeEach(() => {
    clearPluginDeviceAutoSyncAttempts()
  })

  test('processes every plugin independently across serial batches', async () => {
    const responses = [batch(5, 7, 1), batch(5, 2, 6), batch(2, 0, 11)]
    const updateBatch = vi.fn(async () => responses.shift() ?? batch(0, 0))
    const syncPlugin = vi.fn(async (installedPluginId: number) => sync(true, installedPluginId))
    const syncDevice = vi.fn(async () => sync(true))
    const onProgress = vi.fn()

    await expect(
      runPluginAutoUpdate({ updateBatch, syncPlugin, syncDevice, onProgress })
    ).resolves.toEqual({ updatedCount: 12, failedCount: 0, failures: [] })
    expect(updateBatch).toHaveBeenCalledTimes(3)
    expect(syncPlugin).toHaveBeenCalledTimes(12)
    expect(syncDevice).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenLastCalledWith({
      processedCount: 12,
      updatedCount: 12,
      failedCount: 0,
      remainingCount: 0,
    })
  })

  test('reports one plugin failure and continues with later plugins', async () => {
    const responses = [batch(1, 1, 1), batch(1, 0, 2)]
    const updateBatch = vi.fn(async () => responses.shift() ?? batch(0, 0))
    const syncPlugin = vi.fn(async (installedPluginId: number) =>
      sync(installedPluginId !== 1, installedPluginId)
    )
    const syncDevice = vi.fn(async () => sync(true))

    await expect(runPluginAutoUpdate({ updateBatch, syncPlugin, syncDevice })).resolves.toEqual({
      updatedCount: 1,
      failedCount: 1,
      failures: [
        expect.objectContaining({
          installedPluginId: 1,
          pluginName: 'plugin-1',
          stage: 'codex_config',
          errorCode: 'INVALID_CODEX_CONFIG',
          message: 'Invalid Codex config',
        }),
      ],
    })
    expect(updateBatch).toHaveBeenCalledTimes(2)
    expect(syncPlugin).toHaveBeenCalledTimes(2)
    expect(syncDevice).not.toHaveBeenCalled()
  })

  test('does not sync when no update is pending', async () => {
    const updateBatch = vi.fn(async () => batch(0, 0))
    const syncPlugin = vi.fn(async () => sync(true))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(runPluginAutoUpdate({ updateBatch, syncPlugin, syncDevice })).resolves.toEqual({
      updatedCount: 0,
      failedCount: 0,
      failures: [],
    })
    expect(syncPlugin).not.toHaveBeenCalled()
    expect(syncDevice).not.toHaveBeenCalled()
  })

  test('can retry device materialization after the account already advanced', async () => {
    const updateBatch = vi.fn(async () => batch(0, 0))
    const syncPlugin = vi.fn(async () => sync(true))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(
      runPluginAutoUpdate({ updateBatch, syncPlugin, syncDevice, syncWhenNoUpdates: true })
    ).resolves.toEqual({ updatedCount: 0, failedCount: 0, failures: [] })
    expect(syncDevice).toHaveBeenCalledTimes(1)
  })

  test('fails instead of silently finishing when a batch makes no progress', async () => {
    const updateBatch = vi.fn(async () => batch(0, 1))
    const syncPlugin = vi.fn(async () => sync(true))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(runPluginAutoUpdate({ updateBatch, syncPlugin, syncDevice })).rejects.toThrow(
      'Plugin auto-update made no progress'
    )
    expect(syncDevice).not.toHaveBeenCalled()
  })
})

describe('runCurrentDevicePluginAutoUpdate', () => {
  beforeEach(() => {
    clearPluginDeviceAutoSyncAttempts()
  })

  test('resolves the live executor device before applying and materializing updates', async () => {
    const updateBatch = vi.fn(async () => batch(1, 0))
    const syncPlugin = vi.fn(async (_deviceId: string, installedPluginId: number) =>
      sync(true, installedPluginId)
    )
    const syncDevice = vi.fn(async () => sync(true))

    await expect(
      runCurrentDevicePluginAutoUpdate({
        listLocalInstalledPlugins: async () => ({ deviceId: ' device-1 ' }),
        listMarketplacePlugins: async () => ({ items: [] }),
        updateBatch,
        syncPlugin,
        syncDevice,
      })
    ).resolves.toEqual({
      deviceId: 'device-1',
      updatedCount: 1,
      failedCount: 0,
      failures: [],
      deviceSyncPerformed: true,
    })
    expect(syncPlugin).toHaveBeenCalledWith('device-1', 1)
    expect(syncDevice).not.toHaveBeenCalled()
  })

  test('skips cloud requests until the local executor reports a device id', async () => {
    const listMarketplacePlugins = vi.fn(async () => ({ items: [] }))
    const updateBatch = vi.fn(async () => batch(0, 0))
    const syncPlugin = vi.fn(async () => sync(true))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(
      runCurrentDevicePluginAutoUpdate({
        listLocalInstalledPlugins: async () => ({ deviceId: '' }),
        listMarketplacePlugins,
        updateBatch,
        syncPlugin,
        syncDevice,
      })
    ).resolves.toBeNull()
    expect(listMarketplacePlugins).not.toHaveBeenCalled()
    expect(updateBatch).not.toHaveBeenCalled()
    expect(syncPlugin).not.toHaveBeenCalled()
    expect(syncDevice).not.toHaveBeenCalled()
  })

  test('repairs a pending device materialization when the account release is current', async () => {
    const pendingItem = {
      installedPluginId: 10,
      installed: true,
      installedLocally: false,
      currentDeviceInstallation: {
        deviceId: 'device-1',
        desiredReleaseId: 20,
        actualReleaseId: 10,
        state: 'pending',
        attemptCount: 1,
        updatedAt: '2026-08-25T00:00:00Z',
      },
    } as PluginMarketplaceItem
    const syncDevice = vi.fn(async () => sync(true))
    const syncPlugin = vi.fn(async () => sync(true))

    await expect(
      runCurrentDevicePluginAutoUpdate({
        listLocalInstalledPlugins: async () => ({ deviceId: 'device-1' }),
        listMarketplacePlugins: async () => ({ items: [pendingItem] }),
        updateBatch: async () => batch(0, 0),
        syncPlugin,
        syncDevice,
      })
    ).resolves.toEqual({
      deviceId: 'device-1',
      updatedCount: 0,
      failedCount: 0,
      failures: [],
      deviceSyncPerformed: true,
    })
    expect(syncDevice).toHaveBeenCalledWith('device-1')
  })
})

describe('marketplaceItemNeedsPluginAutoUpdate', () => {
  test('retries a failed device update after the account version already advanced', () => {
    expect(
      marketplaceItemNeedsPluginAutoUpdate({
        updateAvailable: false,
        currentDeviceInstallation: {
          deviceId: 'device-1',
          desiredReleaseId: 20,
          actualReleaseId: 10,
          state: 'failed',
          errorCode: 'PLUGIN_SYNC_FAILED',
          errorMessage: 'sync failed',
          attemptCount: 1,
          lastSyncAt: null,
          updatedAt: '2026-08-12T00:00:00Z',
        },
      })
    ).toBe(true)
  })

  test('does not retry an unrelated failed installation without an older usable release', () => {
    expect(
      marketplaceItemNeedsPluginAutoUpdate({
        updateAvailable: false,
        currentDeviceInstallation: {
          deviceId: 'device-1',
          desiredReleaseId: 20,
          actualReleaseId: null,
          state: 'failed',
          errorCode: 'PLUGIN_SYNC_FAILED',
          errorMessage: 'sync failed',
          attemptCount: 1,
          lastSyncAt: null,
          updatedAt: '2026-08-12T00:00:00Z',
        },
      })
    ).toBe(false)
  })

  test('pauses automatic retries after three failures but keeps manual retry available', () => {
    const item = {
      updateAvailable: true,
      currentDeviceInstallation: {
        deviceId: 'device-1',
        desiredReleaseId: 20,
        actualReleaseId: 10,
        state: 'failed' as const,
        errorCode: 'PLUGIN_SYNC_FAILED',
        errorMessage: 'sync failed',
        attemptCount: 3,
        lastSyncAt: null,
        updatedAt: '2026-08-12T00:00:00Z',
      },
    }

    expect(marketplaceItemNeedsPluginAutoUpdate(item)).toBe(false)
    expect(marketplaceItemHasPausedPluginAutoUpdate(item)).toBe(true)
    expect(marketplaceItemCanRetryPluginUpdate(item)).toBe(true)
  })
})
