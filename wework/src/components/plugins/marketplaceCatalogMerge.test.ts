import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  mergeDiskPersonalIntoLocalRows,
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

describe('mergeDiskPersonalIntoLocalRows', () => {
  test('uses disk personal rows when Codex local rows are empty', () => {
    const disk = [{ ...localCatalogPlugin(), id: 'personal-disk:notes', name: 'notes' }]
    expect(mergeDiskPersonalIntoLocalRows([], disk)).toEqual(disk)
  })

  test('keeps Codex rows and appends disk-only personal plugins', () => {
    const diskOnly = {
      ...localCatalogPlugin(),
      id: 'personal-disk:notes',
      name: 'notes',
      displayName: 'Notes',
    }
    const merged = mergeDiskPersonalIntoLocalRows(
      [localCatalogPlugin()],
      [localCatalogPlugin(), diskOnly]
    )
    expect(merged.map(item => item.name).sort()).toEqual(['dev-tools', 'notes'])
  })

  test('collapses Codex and disk copies of the same personal plugin', () => {
    const codex = {
      ...localCatalogPlugin(),
      id: 'dev-tools',
      description: 'Use developer tools in Codex.',
      author: 'Local developer',
      installed: false,
      installedPluginId: null,
      installedLocally: false,
    }
    const disk = {
      ...localCatalogPlugin(),
      id: 'personal-disk:dev-tools',
      description: 'Developer tools plugin with IP geolocation lookup.',
      author: null,
      sourceLabel: '个人分享',
      installed: true,
      installedLocally: true,
      installedPluginId: 'dev-tools@wework-personal',
    }
    const merged = mergeDiskPersonalIntoLocalRows([codex], [disk])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'dev-tools',
      description: 'Use developer tools in Codex.',
      author: 'Local developer',
      installed: true,
      installedLocally: true,
      installedPluginId: 'dev-tools@wework-personal',
    })
  })

  test('collapses personal and wework-personal aliases for the same plugin name', () => {
    const legacyPersonal = {
      ...localCatalogPlugin(),
      id: 'dev-tools@personal',
      manifest: { marketplaceId: 'personal' },
      installed: false,
      installedPluginId: null,
      installedLocally: false,
    }
    const disk = {
      ...localCatalogPlugin(),
      id: 'personal-disk:dev-tools',
      installed: true,
      installedLocally: true,
      installedPluginId: 'dev-tools@wework-personal',
    }
    const merged = mergeDiskPersonalIntoLocalRows([legacyPersonal], [disk])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.installed).toBe(true)
  })
})

describe('mergeMarketplaceCatalog personal dedupe', () => {
  test('keeps a single personal slot when Codex and disk rows both arrive', () => {
    const codex = {
      ...localCatalogPlugin(),
      id: 'dev-tools',
      author: 'Local developer',
      installed: false,
      installedPluginId: null,
    }
    const disk = {
      ...localCatalogPlugin(),
      id: 'personal-disk:dev-tools',
      installed: true,
      installedLocally: true,
      installedPluginId: 'dev-tools@wework-personal',
    }
    const merged = mergeMarketplaceCatalog([], [codex, disk], [])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'dev-tools',
      installed: true,
      installedPluginId: 'dev-tools@wework-personal',
    })
  })
})
