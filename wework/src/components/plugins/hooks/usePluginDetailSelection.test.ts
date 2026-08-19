import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test } from 'vitest'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  findMarketplaceItemForPluginReference,
  openMarketplacePluginDetailSelection,
  usePluginDetailSelection,
} from './usePluginDetailSelection'
import { findPackableCreatedPlugin } from '../pluginOwnerLocalPackage'
import type { InstalledPluginItem } from '../PluginManagementRows'

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

describe('findMarketplaceItemForPluginReference', () => {
  test('matches a cloud catalog row without marketplaceId to wegent aliases', () => {
    expect(
      findMarketplaceItemForPluginReference([documentsItem()], {
        pluginName: 'documents',
        marketplaceName: 'wegent',
      })?.id
    ).toBe(101)
  })

  test('returns null when the catalog does not contain the referenced plugin', () => {
    expect(
      findMarketplaceItemForPluginReference([documentsItem()], {
        pluginName: 'github',
        marketplaceName: 'wegent',
      })
    ).toBeNull()
  })
})

describe('usePluginDetailSelection', () => {
  test('does not reselect after dismiss while the same pluginReference remains', () => {
    const items = [documentsItem()]
    const { result, rerender } = renderHook(
      ({
        items: catalogItems,
        pluginReference,
      }: {
        items: PluginMarketplaceItem[]
        pluginReference: PluginReference | null
      }) => {
        const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
        const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
          string | number | null
        >(null)
        const selection = usePluginDetailSelection({
          pluginReference,
          pluginMarketplaceState: { items: catalogItems, isLoading: false, error: null },
          installedPlugins: [],
          selectedPluginId,
          selectedMarketplacePluginId,
          setSelectedPluginId,
          setSelectedMarketplacePluginId,
        })
        return selection
      },
      {
        initialProps: {
          items,
          pluginReference: {
            pluginName: 'documents',
            marketplaceName: 'wegent',
          } as PluginReference,
        },
      }
    )

    expect(result.current.selectedMarketplacePlugin?.id).toBe(101)

    act(() => {
      result.current.dismissPluginReferenceDetail()
    })
    expect(result.current.selectedMarketplacePlugin).toBeNull()

    rerender({
      items: [...items],
      pluginReference: { pluginName: 'documents', marketplaceName: 'wegent' },
    })
    expect(result.current.selectedMarketplacePlugin).toBeNull()
  })
})

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

  test('still opens the local created package for the owner listing', () => {
    const selected = {
      pluginId: null as string | number | null,
      marketplaceId: null as string | number | null,
    }
    const created: InstalledPluginItem = {
      id: 'local-dev-tools',
      name: 'Dev Tools',
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
          source: { type: 'local', providerKey: 'wework-personal', pluginKey: 'Dev Tools' },
          origin: 'created',
          displayName: 'Dev Tools',
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
      name: 'dev-tools',
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
