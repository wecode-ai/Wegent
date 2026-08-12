import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { holdBackInFlightMarketplaceInstalls } from './holdBackInFlightMarketplaceInstalls'

function marketplaceItem(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: 'desktop-e2e-marketplace:desktop-e2e-plugin@desktop-e2e-marketplace',
    name: 'desktop-e2e-plugin',
    displayName: 'Desktop E2E Plugin',
    description: '',
    version: '0.1.0',
    author: null,
    installed: true,
    installedLocally: true,
    installedPluginId: 'desktop-e2e-plugin@desktop-e2e-marketplace',
    enabled: true,
    updateAvailable: false,
    latestReleaseId: null,
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
    manifest: { marketplaceId: 'desktop-e2e-marketplace' },
    interface: null,
    ...overrides,
  }
}

function installedItem(name: string): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name,
      namespace: 'desktop-e2e-marketplace',
      labels: { id: `${name}@desktop-e2e-marketplace` },
    },
    spec: {
      source: {
        type: 'local',
        providerKey: 'desktop-e2e-marketplace',
        pluginKey: name,
        catalogItemId: `${name}@desktop-e2e-marketplace`,
        marketplace: 'desktop-e2e-marketplace',
      },
      origin: 'market',
      installState: 'installed',
      enabled: true,
      displayName: name,
      description: '',
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
      },
      interface: null,
      packageRef: null,
      sourcePayload: null,
    },
    status: { state: 'enabled' },
  }
  return {
    id: `${name}@desktop-e2e-marketplace`,
    name,
    description: '',
    enabled: true,
    version: '0.1.0',
    origin: 'market',
    sourceLabel: 'Desktop E2E Marketplace',
    distribution: 'external',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('holdBackInFlightMarketplaceInstalls', () => {
  test('clears installed card and strip rows while marketplace install is in flight', () => {
    const item = marketplaceItem()
    const held = holdBackInFlightMarketplaceInstalls({
      items: [item, marketplaceItem({ id: 'other', name: 'other-plugin', installed: true })],
      installed: [installedItem('desktop-e2e-plugin'), installedItem('other-plugin')],
      installingIds: new Set([item.id]),
      authPluginKey: null,
    })

    expect(held.items.find(entry => entry.id === item.id)?.installed).toBe(false)
    expect(held.items.find(entry => entry.name === 'other-plugin')?.installed).toBe(true)
    expect(held.installed.map(entry => entry.name)).toEqual(['other-plugin'])
  })

  test('also holds back rows matching the pending local-auth plugin key', () => {
    const held = holdBackInFlightMarketplaceInstalls({
      items: [marketplaceItem()],
      installed: [installedItem('desktop-e2e-plugin')],
      installingIds: new Set(),
      authPluginKey: 'desktop-e2e-plugin',
    })

    expect(held.items[0]?.installed).toBe(false)
    expect(held.installed).toEqual([])
  })
})
