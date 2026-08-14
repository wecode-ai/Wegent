import { describe, expect, test, vi } from 'vitest'
import type { PluginAutoUpdateBatchResponse, PluginDeviceSyncResponse } from '@/types/api'
import {
  marketplaceItemCanRetryPluginUpdate,
  marketplaceItemHasPausedPluginAutoUpdate,
  marketplaceItemNeedsPluginAutoUpdate,
  runPluginAutoUpdate,
} from './pluginAutoUpdate'

function batch(updatedCount: number, remainingCount: number): PluginAutoUpdateBatchResponse {
  return {
    updated: Array.from({ length: updatedCount }, (_, index) => ({
      installedPluginId: index + 1,
      pluginId: index + 101,
      fromReleaseId: index + 201,
      toReleaseId: index + 301,
      version: '2.0.0',
    })),
    updatedCount,
    remainingCount,
  }
}

function sync(success: boolean): PluginDeviceSyncResponse {
  return {
    deviceId: 'device-1',
    pendingCount: 0,
    sync: {
      success,
      device_id: 'device-1',
      mode: 'replace',
      skills: [],
      plugins: [],
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
  test('processes batches serially and syncs the device once per non-empty batch', async () => {
    const responses = [batch(5, 7), batch(5, 2), batch(2, 0)]
    const updateBatch = vi.fn(async () => responses.shift() ?? batch(0, 0))
    const syncDevice = vi.fn(async () => sync(true))
    const onProgress = vi.fn()

    await expect(runPluginAutoUpdate({ updateBatch, syncDevice, onProgress })).resolves.toBe(12)
    expect(updateBatch).toHaveBeenCalledTimes(3)
    expect(syncDevice).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenLastCalledWith({ updatedCount: 12, remainingCount: 0 })
  })

  test('stops after a failed device sync and leaves later batches untouched', async () => {
    const updateBatch = vi.fn(async () => batch(5, 5))
    const syncDevice = vi.fn(async () => sync(false))

    await expect(runPluginAutoUpdate({ updateBatch, syncDevice })).rejects.toThrow('sync failed')
    expect(updateBatch).toHaveBeenCalledTimes(1)
    expect(syncDevice).toHaveBeenCalledTimes(1)
  })

  test('does not sync when no update is pending', async () => {
    const updateBatch = vi.fn(async () => batch(0, 0))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(runPluginAutoUpdate({ updateBatch, syncDevice })).resolves.toBe(0)
    expect(syncDevice).not.toHaveBeenCalled()
  })

  test('can retry device materialization after the account already advanced', async () => {
    const updateBatch = vi.fn(async () => batch(0, 0))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(
      runPluginAutoUpdate({ updateBatch, syncDevice, syncWhenNoUpdates: true })
    ).resolves.toBe(0)
    expect(syncDevice).toHaveBeenCalledTimes(1)
  })

  test('fails instead of silently finishing when a batch makes no progress', async () => {
    const updateBatch = vi.fn(async () => batch(0, 1))
    const syncDevice = vi.fn(async () => sync(true))

    await expect(runPluginAutoUpdate({ updateBatch, syncDevice })).rejects.toThrow(
      'Plugin auto-update made no progress'
    )
    expect(syncDevice).not.toHaveBeenCalled()
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
