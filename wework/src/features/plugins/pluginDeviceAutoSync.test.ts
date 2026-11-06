// @vitest-environment node

import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  acquirePluginDeviceSync,
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
  collectPluginDeviceStatusReports,
  hasInFlightPluginDeviceSync,
  hasSettledPluginDeviceAutoSync,
  marketplaceItemNeedsDeviceSync,
  marketplaceItemOffersDeviceSyncRetry,
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

  test('waits for another device operation and retains an independent lease', async () => {
    const finishPolicySave = beginPluginDeviceSync('device-a')!
    const pendingUpdate = acquirePluginDeviceSync('device-a')
    const finishOtherDevice = await acquirePluginDeviceSync('device-b')
    finishPolicySave()
    const finishUpdate = await pendingUpdate

    finishPolicySave()
    expect(hasInFlightPluginDeviceSync('device-a')).toBe(true)
    finishUpdate()
    finishOtherDevice()
    expect(hasInFlightPluginDeviceSync('device-a')).toBe(false)
    expect(hasInFlightPluginDeviceSync('device-b')).toBe(false)
  })

  test('cancels a pending lease without releasing its current owner', async () => {
    const finishPolicySave = beginPluginDeviceSync('device-a')!
    const controller = new AbortController()
    const pending = acquirePluginDeviceSync('device-a', controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection

    expect(hasInFlightPluginDeviceSync('device-a')).toBe(true)
    finishPolicySave()
    expect(hasInFlightPluginDeviceSync('device-a')).toBe(false)
  })

  test('does not acquire an already cancelled lease', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(acquirePluginDeviceSync('device-a', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(hasInFlightPluginDeviceSync('device-a')).toBe(false)
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
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 1,
          name: 'a',
          installedPluginId: 10,
          installed: true,
          installedLocally: true,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 1,
            state: 'failed',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(false)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 1,
          name: 'a',
          installedPluginId: 10,
          installed: false,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 2,
            actualReleaseId: 1,
            state: 'failed',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(false)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 1,
          name: 'a',
          installedPluginId: 10,
          installed: true,
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 2,
            actualReleaseId: 1,
            state: 'pending',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(true)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 268634,
          name: 'code-review',
          version: '0.1.3',
          installedPluginId: 268634,
          installed: false,
          installedLocally: true,
          installedVersion: '0.1.2',
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 7,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(true)
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 268634,
          name: 'code-review',
          version: '0.1.2',
          installedPluginId: 268634,
          installed: true,
          installedLocally: true,
          installedVersion: '0.1.2',
          currentDeviceInstallation: {
            deviceId: 'd1',
            desiredReleaseId: 6,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      )
    ).toBe(false)
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

  test('reports stale cloud pending when the package is already local', () => {
    const plugin: InstalledPlugin = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'mail', labels: { id: '101' } },
      spec: {
        source: { type: 'marketplace', providerKey: 'wegent', pluginKey: 'mail' },
        displayName: 'Mail',
        description: '',
        version: '1.0.0',
        installState: 'not_installed',
        enabled: true,
        manifest: {},
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          connectors: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
        pluginId: 7,
        releaseId: 9,
        sourcePayload: { localPresent: true, localVersion: '1.0.0' },
      },
      status: {
        state: 'pending',
        devices: [
          {
            deviceId: 'd1',
            desiredReleaseId: 9,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 0,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }
    expect(collectPluginDeviceStatusReports([plugin], [], 'd1')).toEqual([
      { installedPluginId: 101, releaseId: 9, version: '1.0.0' },
    ])
    expect(
      marketplaceItemNeedsDeviceSync(
        item({
          id: 7,
          name: 'mail',
          installedPluginId: 101,
          installed: true,
          installedLocally: true,
          currentDeviceInstallation: plugin.status.devices?.[0],
        })
      )
    ).toBe(false)
  })

  test('does not report a newer desired version when actualReleaseId is still empty', () => {
    const plugin: InstalledPlugin = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'dingtalk', labels: { id: '101' } },
      spec: {
        source: { type: 'marketplace', providerKey: 'wegent', pluginKey: 'dingtalk' },
        displayName: 'DingTalk',
        description: '',
        version: '0.2.9',
        installState: 'not_installed',
        enabled: true,
        manifest: {},
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          connectors: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
        pluginId: 7,
        releaseId: 10,
        sourcePayload: { localPresent: true, localVersion: '0.2.8' },
      },
      status: {
        state: 'pending',
        devices: [
          {
            deviceId: 'd1',
            desiredReleaseId: 10,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 0,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }
    expect(
      collectPluginDeviceStatusReports(
        [plugin],
        [
          item({
            id: 7,
            name: 'dingtalk',
            version: '0.2.9',
            installedPluginId: 101,
            installed: true,
            installedLocally: true,
            currentDeviceInstallation: plugin.status.devices?.[0],
          }),
        ],
        'd1'
      )
    ).toEqual([])
  })

  test('does not report a newer desired release as already installed', () => {
    const plugin: InstalledPlugin = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'mail', labels: { id: '101' } },
      spec: {
        source: { type: 'marketplace', providerKey: 'wegent', pluginKey: 'mail' },
        displayName: 'Mail',
        description: '',
        installState: 'update_available',
        enabled: true,
        manifest: {},
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          connectors: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
        pluginId: 7,
        releaseId: 10,
        sourcePayload: { localPresent: true },
      },
      status: {
        state: 'pending',
        devices: [
          {
            deviceId: 'd1',
            desiredReleaseId: 10,
            actualReleaseId: 9,
            state: 'pending',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }
    expect(collectPluginDeviceStatusReports([plugin], [], 'd1')).toEqual([])
  })
})
