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

test('wegent cloud catalog rows inherit local wegent installs without marketplaceId', () => {
  const item: PluginMarketplaceItem = {
    id: 267250,
    remotePluginId: 'wegent-sites',
    name: 'wegent-sites',
    displayName: '快速建站',
    description: '用 Wegent 构建并部署站点',
    version: '0.1.5',
    visibility: 'workspace',
    featured: false,
    installed: false,
    installedPluginId: null,
    enabled: false,
    sourceType: 'marketplace',
    components,
    manifest: {},
    ownerUserId: 0,
    latestReleaseId: 10,
    sourceProvider: 'wegent',
    sourceLabel: 'Wegent 官方',
  }
  const installed: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'wegent-sites',
      namespace: 'wegent',
      labels: { id: 'wegent-sites@wegent' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'wegent-sites',
        catalogItemId: 'wegent-sites@wegent',
        marketplace: 'wegent',
      },
      origin: 'marketplace',
      installState: 'installed',
      enabled: true,
      displayName: '快速建站',
      description: '用 Wegent 构建并部署站点',
      componentStates: {},
      components,
      interface: null,
      packageRef: null,
      sourcePayload: { marketplaceName: 'wegent' },
    },
    status: { state: 'enabled' },
  }

  expect(applyInstalledPluginsToMarketplaceItems([item], [installed])).toEqual([
    expect.objectContaining({
      id: 267250,
      installed: true,
      installedPluginId: 'wegent-sites@wegent',
      installedLocally: true,
      enabled: true,
    }),
  ])
})

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
