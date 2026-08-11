import { expect, test } from 'vitest'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { applyInstalledPluginsToMarketplaceItems, applyPluginCloudLinks } from './codexPlugins'

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

test('personal marketplace aliases share installed state', () => {
  const item: PluginMarketplaceItem = {
    id: 'dev-tools@personal',
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
    manifest: { marketplaceId: 'personal' },
    ownerUserId: 0,
    latestReleaseId: null,
  }
  const installed: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'dev-tools',
      namespace: 'wework-personal',
      labels: { id: 'dev-tools@wework-personal' },
    },
    spec: {
      source: {
        type: 'local',
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
      sourcePayload: { marketplaceName: 'wework-personal' },
    },
    status: { state: 'enabled' },
  }

  expect(applyInstalledPluginsToMarketplaceItems([item], [installed])).toEqual([
    expect.objectContaining({
      id: 'dev-tools@personal',
      installed: true,
      installedPluginId: 'dev-tools@wework-personal',
      installedLocally: true,
      enabled: true,
    }),
  ])
})

test('a pending cloud link clears the previous release identity', () => {
  const installed: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'dev-tools',
      namespace: 'wework-personal',
      labels: { id: 'dev-tools@wework-personal' },
    },
    spec: {
      source: {
        type: 'local',
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
        marketplaceName: 'wework-personal',
        cloudPluginId: 71,
        cloudReleaseId: 82,
      },
    },
    status: { state: 'enabled' },
  }

  const [linked] = applyPluginCloudLinks(
    [installed],
    [
      {
        localPluginName: 'dev-tools',
        cloudPluginId: 71,
        cloudReleaseId: null,
      },
    ]
  )

  expect(linked.spec.sourcePayload).toMatchObject({
    cloudPluginId: 71,
    cloudReleaseId: null,
  })
})
