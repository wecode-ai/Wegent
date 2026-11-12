// @vitest-environment node

import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { mergeInstalledPlugins } from './installedPluginMerge'
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
    manifest: {
      marketplaceId: 'wework-personal',
      marketplacePath: '/Users/test/plugins/personal-marketplace.json',
    },
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
  test('keeps personal and enterprise identities separate and links local source to personal', () => {
    const enterprise = {
      ...cloudPlugin(),
      id: 10,
      visibility: 'workspace' as const,
      latestReleaseId: 15,
      relatedPersonalPluginId: 4,
    }

    const merged = mergeMarketplaceCatalog(
      [enterprise, cloudPlugin()],
      [localCatalogPlugin()],
      [localInstalledPlugin()]
    )

    expect(merged).toHaveLength(2)
    expect(merged.find(item => item.id === 4)).toMatchObject({
      visibility: 'personal',
      localPersonalSource: {
        marketplacePath: '/Users/test/plugins/personal-marketplace.json',
        pluginName: 'dev-tools',
      },
    })
    expect(merged.find(item => item.id === 10)).toMatchObject({
      visibility: 'workspace',
      relatedPersonalPluginId: 4,
    })
    expect(merged.find(item => item.id === 10)?.localPersonalSource).toBeUndefined()
  })

  test('collapses legacy and canonical personal marketplace copies', () => {
    const legacy = {
      ...localCatalogPlugin(),
      id: 'dev-tools@personal',
      manifest: { marketplaceId: 'personal' },
    }
    const canonical = localCatalogPlugin()

    const merged = mergeMarketplaceCatalog([], [legacy, canonical], [])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.name).toBe('dev-tools')
  })

  test('marks a cloud workspace row installed from a local wegent install', () => {
    const cloudSites: PluginMarketplaceItem = {
      ...cloudPlugin(),
      id: 267250,
      remotePluginId: 'wegent-sites',
      name: 'wegent-sites',
      displayName: '快速建站',
      visibility: 'workspace',
      installed: false,
      installedPluginId: null,
      latestReleaseId: 10,
      sourceProvider: 'wegent',
      manifest: {},
    }
    const localInstall: InstalledPlugin = {
      ...localInstalledPlugin(),
      metadata: {
        name: 'wegent-sites',
        namespace: 'wegent',
        labels: { id: 'wegent-sites@wegent' },
      },
      spec: {
        ...localInstalledPlugin().spec,
        source: {
          type: 'marketplace',
          providerKey: 'wegent',
          pluginKey: 'wegent-sites',
          catalogItemId: 'wegent-sites@wegent',
          marketplace: 'wegent',
        },
        origin: 'marketplace',
        sourcePayload: { marketplaceName: 'wegent' },
      },
    }
    const merged = mergeMarketplaceCatalog([cloudSites], [], [localInstall])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 267250,
      installed: true,
      installedPluginId: 'wegent-sites@wegent',
      installedLocally: true,
    })
    expect(shouldShowInstalledMarketplaceActions(merged[0], false)).toBe(true)
  })

  test('marks updateAvailable when the local ZIP lags the catalog version', () => {
    const cloudReview: PluginMarketplaceItem = {
      ...cloudPlugin(),
      id: 268634,
      remotePluginId: 'code-review',
      name: 'code-review',
      displayName: 'Code Review',
      version: '0.1.3',
      visibility: 'workspace',
      installed: false,
      installedPluginId: 268634,
      latestReleaseId: 7,
      sourceProvider: 'wegent',
      manifest: {},
      currentDeviceInstallation: {
        deviceId: 'd1',
        desiredReleaseId: 7,
        actualReleaseId: null,
        state: 'pending',
        attemptCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    }
    const cloudInstall: InstalledPlugin = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'code-review', namespace: 'default', labels: { id: 268634 } },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'code-review',
          marketplace: 'wegent',
        },
        pluginId: 268634,
        releaseId: 7,
        version: '0.1.3',
        installState: 'not_installed',
        enabled: true,
        displayName: 'Code Review',
        description: '',
        componentStates: {},
        components,
        interface: null,
        packageRef: null,
        sourcePayload: { localPresent: true, localVersion: '0.1.2' },
      },
      status: {
        state: 'pending',
        devices: [
          {
            deviceId: 'd1',
            desiredReleaseId: 7,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 1,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }

    const merged = mergeMarketplaceCatalog([cloudReview], [], [cloudInstall])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 268634,
      installed: true,
      installedLocally: true,
      installedVersion: '0.1.2',
      version: '0.1.3',
      updateAvailable: true,
    })
  })

  test('marks a cloud row installed from account InstalledPlugin when catalog lags', () => {
    const cloudInstalled: InstalledPlugin = {
      apiVersion: 'wegent.ai/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'weibo-api-wiki', namespace: 'default', labels: { id: '267433' } },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'weibo-api-wiki',
          marketplace: 'wegent',
        },
        pluginId: 4,
        releaseId: 6,
        installState: 'installed',
        enabled: true,
        displayName: '微博小程序H5开发助手',
        description: '',
        componentStates: {},
        components,
        interface: null,
        packageRef: null,
        sourcePayload: {},
      },
      status: { state: 'enabled' },
    }

    const merged = mergeMarketplaceCatalog([cloudPlugin()], [], [cloudInstalled])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 4,
      installed: true,
      installedPluginId: '267433',
      enabled: true,
    })
    expect(shouldShowInstalledMarketplaceActions(merged[0], true)).toBe(true)
  })

  test('preserves the cloud install id when native materialization has another id', () => {
    const installed: InstalledPlugin = {
      ...localInstalledPlugin(),
      metadata: { name: 'dev-tools', namespace: 'default', labels: { id: '66' } },
      spec: {
        ...localInstalledPlugin().spec,
        pluginId: 4,
        sourcePayload: {
          localId: 'dev-tools@wegent',
          localPresent: true,
          cloudInstalledPluginId: '66',
        },
      },
    }
    const merged = mergeMarketplaceCatalog(
      [{ ...cloudPlugin(), installed: true, installedPluginId: 66 }],
      [],
      [installed]
    )
    expect(merged[0].installedPluginId).toBe(66)
    const lagging = mergeMarketplaceCatalog([cloudPlugin()], [], [installed])
    expect(lagging[0].installedPluginId).toBe('66')
  })

  test('preserves account routing when only the managed native inventory refreshes', () => {
    const installed: InstalledPlugin = {
      ...localInstalledPlugin(),
      metadata: { name: 'dev-tools', namespace: 'wegent', labels: { id: 'dev-tools@wegent' } },
      spec: {
        ...localInstalledPlugin().spec,
        source: {
          type: 'marketplace',
          providerKey: 'wegent',
          pluginKey: 'dev-tools',
          marketplace: 'wegent',
        },
        origin: 'market',
        sourcePayload: {
          managedByWegent: true,
          cloudPluginId: 4,
          cloudInstalledPluginId: '66',
        },
      },
    }
    const catalog = { ...cloudPlugin(), installed: true, installedPluginId: 66 }
    expect(mergeMarketplaceCatalog([catalog], [], [installed])[0].installedPluginId).toBe(66)
    expect(mergeMarketplaceCatalog([cloudPlugin()], [], [installed])[0].installedPluginId).toBe(
      '66'
    )
  })

  test('marks a pending cloud row installed locally when Codex already has the package', () => {
    const cloudPending: PluginMarketplaceItem = {
      ...cloudPlugin(),
      installed: true,
      installedPluginId: 4,
      currentDeviceInstallation: {
        deviceId: 'current-device',
        desiredReleaseId: 6,
        actualReleaseId: null,
        state: 'pending',
        attemptCount: 0,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    }
    const cloudInstalled: InstalledPlugin = {
      apiVersion: 'wegent.ai/v1',
      kind: 'InstalledPlugin',
      metadata: { name: 'dev-tools', namespace: 'default', labels: { id: '4' } },
      spec: {
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dev-tools',
          marketplace: 'wegent',
        },
        pluginId: 4,
        releaseId: 6,
        installState: 'installed',
        enabled: true,
        displayName: 'Dev Tools',
        description: '',
        componentStates: {},
        components,
        interface: null,
        packageRef: null,
        sourcePayload: {},
      },
      status: {
        state: 'enabled',
        devices: [
          {
            deviceId: 'current-device',
            desiredReleaseId: 6,
            actualReleaseId: null,
            state: 'pending',
            attemptCount: 0,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }
    const localInstall: InstalledPlugin = {
      ...localInstalledPlugin(),
      spec: {
        ...localInstalledPlugin().spec,
        origin: 'market',
        source: {
          type: 'marketplace',
          providerKey: 'wegent',
          pluginKey: 'dev-tools',
          catalogItemId: 'dev-tools@wegent',
          marketplace: 'wegent',
        },
        sourcePayload: { marketplaceName: 'wegent' },
      },
    }

    const mergedInstalled = mergeInstalledPlugins(
      [cloudInstalled],
      [localInstall],
      'current-device'
    )
    const merged = mergeMarketplaceCatalog([cloudPending], [], mergedInstalled)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 4,
      installed: true,
      installedLocally: true,
      currentDeviceInstallation: {
        deviceId: 'current-device',
        state: 'pending',
      },
    })
  })

  test('does not transfer local version evidence across same-name catalog ids', () => {
    const sameNameFromAnotherMarketplace: PluginMarketplaceItem = {
      ...localCatalogPlugin(),
      id: 'dev-tools@openai-bundled',
      installedLocally: true,
      installedVersion: '9.9.9',
      manifest: { marketplaceId: 'openai-bundled' },
    }

    const merged = mergeMarketplaceCatalog([cloudPlugin()], [sameNameFromAnotherMarketplace], [])

    expect(merged[0]?.installedLocally).not.toBe(true)
    expect(merged[0]?.installedVersion).not.toBe('9.9.9')
  })
})

describe('mergeMarketplaceCatalog personal dedupe', () => {
  test('overlays a lagging OpenAI official catalog row from the installed list', () => {
    const catalog = {
      ...localCatalogPlugin(),
      id: 'github@openai-curated-remote',
      name: 'github',
      displayName: 'GitHub',
      installed: false,
      installedLocally: false,
      installedPluginId: null,
      enabled: false,
      manifest: { marketplaceId: 'openai-curated-remote' },
    }
    const installed: InstalledPlugin = {
      ...localInstalledPlugin(),
      metadata: {
        name: 'github',
        namespace: 'openai-curated-remote',
        labels: { id: 'github@openai-curated-remote' },
      },
      spec: {
        ...localInstalledPlugin().spec,
        source: {
          type: 'marketplace',
          providerKey: 'openai-curated-remote',
          pluginKey: 'github',
          catalogItemId: 'github@openai-curated-remote',
          marketplace: 'openai-curated-remote',
        },
        origin: 'marketplace',
        sourcePayload: { marketplaceName: 'openai-curated-remote' },
      },
    }
    const merged = mergeMarketplaceCatalog([], [catalog], [installed])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'github@openai-curated-remote',
      installed: true,
      installedLocally: true,
      installedPluginId: 'github@openai-curated-remote',
    })
  })
})
