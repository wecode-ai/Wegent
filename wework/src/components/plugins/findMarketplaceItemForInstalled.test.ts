// @vitest-environment node

import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
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
  test('does not associate a legacy installation directory with another marketplace listing', () => {
    const item = marketplaceItem({
      id: 4,
      name: 'documents',
      manifest: { marketplaceId: 'wegent' },
    })
    const plugin = installedItem({
      id: '99-wework-personal-documents-0.1.3',
      pluginKey: 'documents',
      marketplace: 'wework-personal',
    })
    expect(findMarketplaceItemForInstalled(plugin, [item])).toBeNull()
  })

  test('matches by installedPluginId when no cloud identity is known', () => {
    const items = [
      marketplaceItem({ id: 4, name: 'dingtalk', installedPluginId: '62' }),
      marketplaceItem({ id: 9, name: 'dingtalk', installedPluginId: '99' }),
    ]
    const plugin = installedItem({
      id: '62',
      pluginKey: 'dingtalk',
      marketplace: 'wegent',
    })
    expect(findMarketplaceItemForInstalled(plugin, items)?.id).toBe(4)
  })

  test('never substitutes a same-name owner for an explicit cloud identity', () => {
    const owner = marketplaceItem({
      id: 4,
      name: 'shared',
      accessRole: 'owner',
      installedPluginId: '62',
    })
    const recipient = marketplaceItem({ id: 9, name: 'shared', accessRole: 'recipient' })
    const plugin = installedItem({ id: '62', pluginKey: 'shared', pluginId: 9 })
    expect(findMarketplaceItemForInstalled(plugin, [owner, recipient])).toBe(recipient)
    expect(findMarketplaceItemForInstalled(plugin, [owner])).toBeNull()
    delete plugin.raw.spec.pluginId
    plugin.raw.spec.sourcePayload = { cloudPluginId: 9 }
    expect(findMarketplaceItemForInstalled(plugin, [owner, recipient])).toBe(recipient)
    expect(findMarketplaceItemForInstalled(plugin, [owner])).toBeNull()
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
})
