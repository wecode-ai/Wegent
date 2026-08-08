import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '@/components/plugins/PluginManagementRows'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  marketplaceItemsSignature,
  pluginMarketplaceCacheKey,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from './pluginMarketplaceCache'

function item(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.name,
    description: '',
    version: '1.0.0',
    author: null,
    visibility: 'public',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    interface: null,
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
      connectors: [],
    },
    ownerUserId: 0,
    sourceLabel: '',
    latestReleaseId: null,
    manifest: {},
    ...overrides,
  }
}

describe('pluginMarketplaceCache', () => {
  test('stores and returns snapshots by cache key', () => {
    clearPluginMarketplaceCache()
    const key = pluginMarketplaceCacheKey('http://api', 'token-abc')
    setPluginMarketplaceCache({
      cacheKey: key,
      marketplaceItems: [item({ id: 1, name: 'a', installed: true })],
      installedPlugins: [],
      marketplaces: [],
      selectedMarketplaceKey: '',
      deviceId: 'device-1',
      canPublish: false,
      canSharePersonalPlugins: true,
      fetchedAt: Date.now(),
    })
    expect(getPluginMarketplaceCache(key)?.deviceId).toBe('device-1')
    expect(getPluginMarketplaceCache('other')).toBeNull()
  })

  test('detects marketplace item changes via signature', () => {
    const left = [item({ id: 1, name: 'a', version: '1.0.0', installed: false })]
    const right = [item({ id: 1, name: 'a', version: '1.0.0', installed: true })]
    expect(sameMarketplaceItems(left, left)).toBe(true)
    expect(sameMarketplaceItems(left, right)).toBe(false)
    expect(marketplaceItemsSignature(left)).not.toBe(marketplaceItemsSignature(right))
  })

  test('detects device installation state changes via signature', () => {
    const base = item({ id: 1, name: 'a', installed: false })
    const failed = item({
      id: 1,
      name: 'a',
      installed: false,
      currentDeviceInstallation: {
        deviceId: 'd1',
        desiredReleaseId: 1,
        actualReleaseId: null,
        state: 'failed',
        errorCode: 'PLUGIN_SYNC_FAILED',
        errorMessage: 'rejected',
        attemptCount: 1,
        lastSyncAt: null,
        updatedAt: null,
      },
    })
    expect(sameMarketplaceItems([base], [failed])).toBe(false)
  })

  test('detects installed plugin name and distribution changes via signature', () => {
    const left: InstalledPluginItem[] = [
      {
        id: '1',
        name: 'Dev Tools',
        description: '',
        enabled: true,
        version: '0.1.0',
        origin: 'created',
        sourceLabel: '我创建的',
        distribution: 'personal',
        updateAvailable: false,
        componentCounts: {},
        raw: {
          apiVersion: 'v1',
          kind: 'InstalledPlugin',
          metadata: {},
          spec: {
            source: { type: 'local', providerKey: 'p', pluginKey: 'dev-tools' },
            origin: 'created',
            displayName: 'Dev Tools',
            description: '',
            installState: 'installed',
            enabled: true,
            componentStates: {},
            components: {
              skills: [],
              commands: [],
              agents: [],
              hooks: [],
              mcps: [],
              lsps: [],
              monitors: [],
              bins: [],
              connectors: [],
            },
            interface: null,
          },
          status: { state: 'enabled' },
        },
      },
    ]
    const right = [{ ...left[0], name: 'Dev Tools 2', distribution: 'public' as const }]
    expect(sameInstalledPlugins(left, left)).toBe(true)
    expect(sameInstalledPlugins(left, right)).toBe(false)
  })
})
