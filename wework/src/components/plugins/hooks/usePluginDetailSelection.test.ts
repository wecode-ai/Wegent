import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test } from 'vitest'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  findMarketplaceItemForPluginReference,
  usePluginDetailSelection,
} from './usePluginDetailSelection'

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
