// @vitest-environment node

import type { PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { findPackableCreatedPlugin } from '../pluginOwnerLocalPackage'
import { openMarketplacePluginDetailSelection } from './usePluginDetailSelection'

const emptyComponents = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
  connectors: [],
}

function documentsItem(): PluginMarketplaceItem {
  return {
    id: 101,
    remotePluginId: 'openai-documents',
    name: 'documents',
    displayName: 'Documents',
    description: 'Create and edit document artifacts',
    visibility: 'public',
    featured: false,
    installed: true,
    installedPluginId: 101,
    enabled: true,
    sourceType: 'marketplace',
    sourceProvider: 'wegent',
    sourceLabel: 'Wegent 官方',
    components: emptyComponents,
    manifest: {},
    ownerUserId: 0,
    latestReleaseId: 1001,
  }
}

describe('openMarketplacePluginDetailSelection', () => {
  test('keeps recipient shares on the marketplace listing even if a local created name matches', () => {
    const selected = {
      pluginId: null as string | number | null,
      marketplaceId: null as string | number | null,
    }
    const created: InstalledPluginItem = {
      id: 'local-video-studio',
      name: 'Wework 教学视频工作室',
      description: '',
      enabled: true,
      origin: 'created',
      sourceLabel: '我创建的',
      distribution: 'personal',
      updateAvailable: false,
      componentCounts: {},
      raw: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'InstalledPlugin',
        metadata: {
          name: 'wework-video-studio',
          namespace: 'wework-personal',
          labels: { id: 'local-video-studio' },
        },
        spec: {
          source: {
            type: 'local',
            providerKey: 'wework-personal',
            pluginKey: 'wework-video-studio',
          },
          origin: 'created',
          displayName: 'Wework 教学视频工作室',
          description: '',
          installState: 'installed',
          enabled: true,
          componentStates: {},
          components: emptyComponents,
          interface: null,
          packageRef: null,
          sourcePayload: null,
        },
        status: { state: 'enabled' },
      },
    }
    const shared: PluginMarketplaceItem = {
      ...documentsItem(),
      id: 268900,
      name: 'wework-tutorial-studio',
      displayName: 'Wework 教学视频工作室',
      accessRole: 'recipient',
      allowCopy: true,
      ownerDisplayName: 'qindi',
      visibility: 'personal',
      latestReleaseId: 9,
    }

    openMarketplacePluginDetailSelection({
      item: shared,
      installedPlugins: [created],
      findPackableCreatedPlugin,
      setSelectedPluginId: value => {
        selected.pluginId = typeof value === 'function' ? value(selected.pluginId) : value
      },
      setSelectedMarketplacePluginId: value => {
        selected.marketplaceId = typeof value === 'function' ? value(selected.marketplaceId) : value
      },
    })

    expect(selected.pluginId).toBeNull()
    expect(selected.marketplaceId).toBe(268900)
  })

  test.each([
    {
      scenario: 'matching display names',
      pluginKey: 'Dev Tools',
      localDisplayName: 'Dev Tools',
      listingName: 'dev-tools',
    },
    {
      scenario: 'changed display name',
      pluginKey: 'dev-tools',
      localDisplayName: 'New Developer Tools',
      listingName: 'Dev Tools',
    },
  ])('still opens the local created package for the owner listing ($scenario)', scenario => {
    const { pluginKey, localDisplayName, listingName } = scenario
    const selected = {
      pluginId: null as string | number | null,
      marketplaceId: null as string | number | null,
    }
    const created: InstalledPluginItem = {
      id: 'local-dev-tools',
      name: localDisplayName,
      description: '',
      enabled: true,
      origin: 'created',
      sourceLabel: '我创建的',
      distribution: 'personal',
      updateAvailable: false,
      componentCounts: {},
      raw: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'InstalledPlugin',
        metadata: {
          name: 'dev-tools',
          namespace: 'wework-personal',
          labels: { id: 'local-dev-tools' },
        },
        spec: {
          source: { type: 'local', providerKey: 'wework-personal', pluginKey },
          origin: 'created',
          displayName: localDisplayName,
          description: '',
          installState: 'installed',
          enabled: true,
          componentStates: {},
          components: emptyComponents,
          interface: null,
          packageRef: null,
          sourcePayload: null,
        },
        status: { state: 'enabled' },
      },
    }
    const owned: PluginMarketplaceItem = {
      ...documentsItem(),
      id: 4,
      name: listingName,
      displayName: 'Dev Tools',
      accessRole: 'owner',
      visibility: 'personal',
      latestReleaseId: 6,
    }

    openMarketplacePluginDetailSelection({
      item: owned,
      installedPlugins: [created],
      findPackableCreatedPlugin,
      setSelectedPluginId: value => {
        selected.pluginId = typeof value === 'function' ? value(selected.pluginId) : value
      },
      setSelectedMarketplacePluginId: value => {
        selected.marketplaceId = typeof value === 'function' ? value(selected.marketplaceId) : value
      },
    })

    expect(selected.pluginId).toBe('local-dev-tools')
    expect(selected.marketplaceId).toBeNull()
  })
})
