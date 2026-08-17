import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'

const components = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
}

function marketplaceItem(
  overrides: Partial<PluginMarketplaceItem> & Pick<PluginMarketplaceItem, 'id' | 'name'>
): PluginMarketplaceItem {
  return {
    remotePluginId: String(overrides.id),
    displayName: overrides.displayName ?? overrides.name,
    description: '',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    visibility: 'public',
    ownerUserId: 0,
    components,
    manifest: {},
    ...overrides,
  }
}

function installedItem(
  overrides: Partial<InstalledPluginItem> & {
    id: string | number
    pluginKey: string
    pluginId?: number
    marketplace?: string
    origin?: 'created' | 'market'
  }
): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'wegent.ai/v1',
    kind: 'InstalledPlugin',
    metadata: { name: overrides.pluginKey, namespace: overrides.marketplace ?? 'default' },
    spec: {
      source: {
        type: overrides.origin === 'created' ? 'local' : 'marketplace',
        providerKey: overrides.marketplace ?? 'wegent-market',
        pluginKey: overrides.pluginKey,
        marketplace: overrides.marketplace ?? 'wegent',
      },
      origin: overrides.origin ?? 'market',
      pluginId: overrides.pluginId,
      installState: 'installed',
      enabled: true,
      displayName: overrides.name ?? overrides.pluginKey,
      description: '',
      componentStates: {},
      components,
      interface: null,
      packageRef: null,
      sourcePayload: {},
    },
    status: { state: 'enabled' },
  }
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.pluginKey,
    description: '',
    enabled: true,
    version: '1.0.0',
    origin: overrides.origin ?? 'market',
    sourceLabel: 'Wegent',
    distribution: 'public',
    updateAvailable: false,
    componentCounts: {},
    raw,
    ...overrides,
  }
}

describe('findMarketplaceItemForInstalled', () => {
  test('matches by installedPluginId first', () => {
    const items = [
      marketplaceItem({ id: 4, name: 'dingtalk', installedPluginId: '62' }),
      marketplaceItem({ id: 9, name: 'dingtalk', installedPluginId: '99' }),
    ]
    const plugin = installedItem({
      id: '62',
      pluginKey: 'dingtalk',
      pluginId: 9,
      marketplace: 'wegent',
    })
    expect(findMarketplaceItemForInstalled(plugin, items)?.id).toBe(4)
  })

  test('matches by cloud pluginId when installedPluginId is absent', () => {
    const items = [marketplaceItem({ id: 4, name: 'dingtalk', latestReleaseId: 6 })]
    const plugin = installedItem({
      id: '62',
      pluginKey: 'other-name',
      pluginId: 4,
      marketplace: 'wegent',
    })
    expect(findMarketplaceItemForInstalled(plugin, items)?.id).toBe(4)
  })

  test('matches by pluginKey and marketplace alias', () => {
    const items = [
      marketplaceItem({
        id: 'dingtalk@wework',
        name: 'dingtalk',
        latestReleaseId: null,
        manifest: { marketplaceId: 'wework' },
      }),
    ]
    const plugin = installedItem({
      id: 'local-1',
      pluginKey: 'dingtalk',
      marketplace: 'wegent',
    })
    expect(findMarketplaceItemForInstalled(plugin, items)?.id).toBe('dingtalk@wework')
  })

  test('returns null for personal plugins with no catalog row', () => {
    const items = [marketplaceItem({ id: 4, name: 'dingtalk', latestReleaseId: 6 })]
    const plugin = installedItem({
      id: 'notes@wework-personal',
      pluginKey: 'notes',
      marketplace: 'wework-personal',
      origin: 'created',
    })
    expect(findMarketplaceItemForInstalled(plugin, items)).toBeNull()
  })
})
