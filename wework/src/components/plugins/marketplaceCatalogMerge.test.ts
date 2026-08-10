import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  mergeMarketplaceCatalog,
  shouldShowInstalledMarketplaceActions,
} from './marketplaceCatalogMerge'

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

function cloudPlugin(): PluginMarketplaceItem {
  return {
    id: 4,
    remotePluginId: 'dev-tools',
    name: 'dev-tools',
    displayName: 'Dev Tools',
    description: 'Developer tools',
    version: '0.1.0',
    visibility: 'personal',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    components,
    manifest: {},
    ownerUserId: 1,
    accessRole: 'owner',
    latestReleaseId: 6,
  }
}

function localCatalogPlugin(): PluginMarketplaceItem {
  return {
    ...cloudPlugin(),
    id: 'dev-tools@wework-personal',
    remotePluginId: 'dev-tools',
    installed: true,
    installedPluginId: 'dev-tools-local',
    enabled: true,
    latestReleaseId: null,
    sourceProvider: 'user',
    manifest: { marketplaceId: 'wework-personal' },
  }
}

function localInstalledPlugin(): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'dev-tools',
      namespace: 'wework-personal',
      labels: { id: 'dev-tools-local' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wework-personal',
        pluginKey: 'dev-tools',
        catalogItemId: 'dev-tools@wework-personal',
        marketplace: 'wework-personal',
      },
      origin: 'created',
      installState: 'installed',
      enabled: true,
      displayName: 'Dev Tools',
      description: 'Developer tools',
      componentStates: {},
      components,
      interface: null,
      packageRef: null,
      sourcePayload: {
        pluginName: 'dev-tools',
        cloudPluginId: 4,
        cloudReleaseId: 6,
      },
    },
    status: { state: 'enabled' },
  }
}

describe('mergeMarketplaceCatalog', () => {
  test('treats a linked local creation as the installed cloud listing', () => {
    const merged = mergeMarketplaceCatalog(
      [cloudPlugin()],
      [localCatalogPlugin()],
      [localInstalledPlugin()]
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 4,
      installed: true,
      installedPluginId: 'dev-tools-local',
      installedLocally: true,
      enabled: true,
      updateAvailable: false,
      currentDeviceInstallation: null,
    })
    expect(shouldShowInstalledMarketplaceActions(merged[0], false)).toBe(true)
  })

  test('keeps distinct cloud plugins that share a display name', () => {
    const duplicateName = {
      ...cloudPlugin(),
      id: 9,
      remotePluginId: 'dev-tools-fork',
      name: 'dev-tools',
      displayName: 'Dev Tools Fork',
      latestReleaseId: 12,
    }
    const merged = mergeMarketplaceCatalog([cloudPlugin(), duplicateName], [], [])
    expect(merged).toHaveLength(2)
    expect(merged.map(item => item.id).sort()).toEqual([4, 9])
  })

  test('keeps local installed actions available while signed out', () => {
    expect(shouldShowInstalledMarketplaceActions(localCatalogPlugin(), false)).toBe(true)
    expect(shouldShowInstalledMarketplaceActions(cloudPlugin(), false)).toBe(false)
  })
})
