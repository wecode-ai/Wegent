import { beforeEach, describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  clearPluginDeviceAutoSyncAttempts,
  hasAttemptedPluginDeviceAutoSync,
  hasSettledPluginDeviceAutoSync,
  marketplaceItemNeedsDeviceSync,
  marketplaceItemOffersDeviceSyncRetry,
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
  withOptimisticDevicePending,
} from './pluginDeviceAutoSync'

function item(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.name,
    description: '',
    visibility: 'workspace',
    featured: false,
    installed: false,
    enabled: false,
    sourceType: 'marketplace',
    components: {
      skills: [],
      commands: [],
      apps: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
      connectors: [],
    },
    manifest: {},
    ownerUserId: 1,
    ...overrides,
  }
}

describe('pluginDeviceAutoSync', () => {
  beforeEach(() => {
    clearPluginDeviceAutoSyncAttempts()
  })

  test('detects account installs that are missing on the current device', () => {
    expect(
      marketplaceItemNeedsDeviceSync(
        item({ id: 1, name: 'a', installedPluginId: 10, installed: false })
      )
    ).toBe(true)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 1,
          name: 'a',
          installedPluginId: 10,
          installed: true,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 1,
            state: 'failed',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(true)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 1,
          name: 'a',
          installedPluginId: 10,
          installed: true,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 1,
            state: 'installed',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(false)
  })

  test('tracks one auto-sync attempt per device id', () => {
    expect(hasAttemptedPluginDeviceAutoSync('device-a')).toBe(false)
    markPluginDeviceAutoSyncAttempted('device-a')
    expect(hasAttemptedPluginDeviceAutoSync('device-a')).toBe(true)
    expect(hasAttemptedPluginDeviceAutoSync('device-b')).toBe(false)
  })

  test('offers retry for pending gaps after auto-sync settles', () => {
    const pending = item({
      id: 1,
      name: 'gap',
      installedPluginId: 10,
      installed: false,
      currentDeviceInstallation: {
        deviceId: 'd1',
        desiredReleaseId: 5,
        state: 'pending',
        attemptCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    })
    expect(marketplaceItemOffersDeviceSyncRetry(pending, { autoSyncSettled: false })).toBe(false)
    markPluginDeviceAutoSyncSettled('d1')
    expect(hasSettledPluginDeviceAutoSync('d1')).toBe(true)
    expect(marketplaceItemOffersDeviceSyncRetry(pending, { autoSyncSettled: true })).toBe(true)
  })

  test('optimistically marks gap rows as pending', () => {
    const next = withOptimisticDevicePending(
      [
        item({
          id: 1,
          name: 'gap',
          installedPluginId: 10,
          installed: false,
          latestReleaseId: 5,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 5,
            state: 'failed',
            errorCode: 'PLUGIN_SYNC_FAILED',
            errorMessage: 'omitted',
            attemptCount: 2,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        }),
        item({ id: 2, name: 'fresh', installedPluginId: null, installed: false }),
      ],
      'd1'
    )
    expect(next[0]?.currentDeviceInstallation?.state).toBe('pending')
    expect(next[0]?.currentDeviceInstallation?.errorMessage).toBeNull()
    expect(next[1]?.currentDeviceInstallation).toBeUndefined()
  })
})
